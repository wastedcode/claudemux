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
