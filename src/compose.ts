import { SessionGone } from "./errors.js";
import { adopt } from "./session/adopt.js";
import { type ResumeOptions, resume } from "./session/resume.js";
import type { Cursor, Message, ReadyOpts, SessionHandle, TurnOutcome } from "./types.js";

/**
 * The composition seam — the **single owner** of multi-primitive workflows over
 * a {@link SessionHandle}. It holds no belief and no content of its own: it only
 * sequences the primitives, each of which stays the sole owner of its decision.
 * Both the CLI (`claudemux ask`) and programmatic consumers (e.g. Posse) call
 * THIS, so the round-trip has one owner rather than one per interface face.
 */

/** What {@link ask} returns: the full outcome, the messages, and the cursor. */
export interface AskResult {
  /**
   * The terminal {@link TurnOutcome}, surfaced in full — never swallowed.
   * `completed` is the happy path; `awaiting`/`aborted`/`budget-exceeded`/
   * `degraded` are first-class and the caller must branch on them.
   */
  readonly outcome: TurnOutcome;
  /**
   * The messages produced since this turn's `send`, read via the one content
   * owner ({@link SessionHandle.messagesSince}). On `completed` they are the
   * full, flushed reply (race-free); on a non-`completed` outcome they are
   * whatever has landed so far (possibly partial) — interpret with `outcome`.
   */
  readonly messages: readonly Message[];
  /** The cursor this turn's `send` produced — re-read content later with it. */
  readonly cursor: Cursor;
}

/**
 * Do one Q&A round-trip: **send** the prompt, **wait** for the turn to reach a
 * terminal {@link TurnOutcome}, then read the **messages** since it. Pure
 * composition of the three primitives — `ask` is sugar, not a third source of
 * truth: content still flows only through `messagesSince`, the outcome only
 * through `wait`.
 *
 * @example
 * ```ts
 * import { create, ask } from "claudemux";
 * const session = await create({ name: "job", cwd: process.cwd() });
 * const { outcome, messages } = await ask(session, "What's 2+2?");
 * if (outcome.kind === "completed") console.log(messages.at(-1));
 * else handleAbnormal(outcome); // awaiting / aborted / budget-exceeded / degraded
 * ```
 */
export async function ask(
  session: SessionHandle,
  text: string,
  opts?: ReadyOpts,
): Promise<AskResult> {
  const cursor = await session.send(text);
  const outcome = await session.wait(opts);
  const messages = await session.messagesSince(cursor);
  return { outcome, messages, cursor };
}

/**
 * How a session was reconnected on daemon boot — see {@link recover}.
 *   - `"attached"` — the pane was **still alive** (your process restarted, the
 *     session didn't); reconnected, nothing lost.
 *   - `"resumed"` — the pane was **gone** (it crashed, or the box lost its tmux
 *     server); the conversation was continued in a **fresh** pane. A turn may
 *     have been in flight when it died — check `turnComplete(yourLastCursor)`.
 */
export type RecoverStatus = "attached" | "resumed";

/** What {@link recover} returns: the live handle + how it was recovered. */
export interface RecoverResult {
  readonly session: SessionHandle;
  readonly status: RecoverStatus;
}

/**
 * Reconnect to a session on boot — the **reconnect compound**, one decision
 * (attach the live pane vs resume the dead one) composed from two atomic
 * sub-owners ({@link adopt} and {@link resume}). It owns no policy beyond that:
 * the re-send decision stays the consumer's (via `turnComplete`). A daemon calls
 * THIS for each `{ name, agentSessionId }` it persisted, instead of hand-rolling
 * a `try`/catch-`SessionGone`/resume dance — and the returned {@link RecoverStatus}
 * makes "did it crash?" a field, not control flow you write yourself. Only
 * `SessionGone` from `adopt` (uniform across both crash modes) triggers the
 * resume fallback; any other adopt error propagates — those are caller mistakes,
 * not crashes.
 *
 * @example
 * ```ts
 * // daemon boot, per persisted { name, agentSessionId, cwd, lastCursor, lastPrompt }:
 * const { session, status } = await recover({ name, agentSessionId, cwd });
 * if (status === "resumed" && !(await session.turnComplete(lastCursor)))
 *   await session.send(lastPrompt);   // it crashed mid-turn — re-send the one lost turn
 * // status === "attached" ⇒ the session never went down; just keep going.
 * ```
 */
export async function recover(opts: ResumeOptions): Promise<RecoverResult> {
  try {
    const session = await adopt({
      name: opts.name,
      ...(opts.namespace === undefined ? {} : { namespace: opts.namespace }),
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
      ...(opts.backend === undefined ? {} : { backend: opts.backend }),
    });
    return { session, status: "attached" };
  } catch (e) {
    if (!(e instanceof SessionGone)) throw e; // a real adopt error, not a crash
    const session = await resume(opts);
    return { session, status: "resumed" };
  }
}
