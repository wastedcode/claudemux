import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { PromptResponseUnsupported } from "../errors.js";
import { interruptOnce } from "../io/interrupt.js";
import { respondOnce } from "../io/respond.js";
import { sendOnce, submitOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForOutcome } from "../io/wait.js";
import type { Belief } from "../observe/observer.js";
import { SessionObserver } from "../observe/session-observer.js";
import { classify } from "../state/classifier.js";
import type {
  BackendCommandEvent,
  Message,
  Progress,
  PromptChoice,
  ReadyOpts,
  SessionHandle,
  TurnOutcome,
} from "../types.js";
import { stripSgr } from "../util/ansi.js";
import { sleep } from "../util/sleep.js";
import { CLASSIFIER_CAPTURE } from "./constants.js";
import { rendezvousPathFor } from "./hooks.js";
import { Mutex } from "./mutex.js";

/**
 * The {@link Cursor} {@link SessionHandle.send} returns when it could **not
 * confirm delivery** — no user record for the sent text appeared (a lost Enter,
 * a boot-race drop). It is a detectable sentinel, NOT a positional count: a count
 * cursor persisted and reused later would silently slice the WHOLE transcript
 * ("everything since index 0"). `messagesSince`/`turnComplete` on this sentinel
 * read empty/false, so an unconfirmed turn surfaces as "re-send me", never a
 * flood. Consumers can compare `cursor === DELIVERY_UNCONFIRMED`.
 */
export const DELIVERY_UNCONFIRMED = "delivery-unconfirmed";

/**
 * The {@link Cursor} {@link SessionHandle.send} returns when the message was sent
 * into a **busy** session and the agent **queued** it — accepted, and it will run
 * after the in-flight turn finishes (claude shows "Press up to edit queued
 * messages"). Distinct from {@link DELIVERY_UNCONFIRMED} on purpose: the message
 * is NOT lost, so a consumer must **not** re-send (that would double-run). Its
 * user record does not exist yet (the queued turn hasn't started), so like
 * `DELIVERY_UNCONFIRMED` it resolves empty in `messagesSince`/`turnComplete` —
 * the consumer `wait()`s for the current turn, lets the queued turn run, then
 * reads with a fresh cursor. Compare `cursor === DELIVERED_QUEUED`.
 */
export const DELIVERED_QUEUED = "delivered-queued";

interface HandleDeps {
  backend: Backend;
  agent: AgentDef;
  namespace: string;
  name: string;
  /**
   * The agent's conversation id, when known — surfaced as
   * {@link SessionHandle.agentSessionId}. `undefined` for sessions with no
   * recoverable id (older/non-claudemux, a cache-miss at adopt, or a bare
   * `--resume`); never fabricated.
   */
  agentSessionId?: string;
  /**
   * The hook rendezvous file injected at spawn (for the observe channel). When
   * absent (e.g. {@link attachHandle}/adopt), the handle re-derives it from
   * {@link agentSessionId} — correct for the common (non-resume) case.
   */
  rendezvousPath?: string;
}

/**
 * Build a {@link SessionHandle} backed by a per-handle mutex. Every public
 * method that mutates or reads pane state goes through the mutex so
 * concurrent consumer calls cannot interleave bytes.
 */
export function makeHandle(deps: HandleDeps): SessionHandle {
  const ref: SessionRef = { namespace: deps.namespace, name: deps.name };
  const mutex = new Mutex();
  // Authoritative session-interaction state: this handle issued an `interrupt()`
  // not yet superseded by a `send()`. An interrupt fires no `stop` edge and
  // leaves the spinner's "esc to interrupt" frozen in scrollback, so neither
  // the hook nor the pane can tell aborted from working — but the handle knows.
  let interruptPending = false;

  // The per-handle stateful read core: incremental (bounded) reads of the hook
  // rendezvous + transcript. state()/progress()/wait()/messagesSince all defer to
  // it — one owner of "what's true", parsing only newly-appended bytes per poll.
  const rv = rendezvousPath(deps);
  const observer = new SessionObserver({
    agent: deps.agent,
    ...(rv === undefined ? {} : { rendezvousPath: rv }),
    ...(deps.agentSessionId === undefined ? {} : { agentSessionId: deps.agentSessionId }),
  });

  /**
   * Capture + classify the pane, fuse with the observer's belief. The capture
   * failure is NOT swallowed: in tmux a failed capture means the session/server
   * is gone (terminal), so `SessionGone`/`BackendUnreachable` propagates.
   */
  const readBelief = async (
    weInterrupted: boolean,
  ): Promise<{ belief: Belief; paneText: string }> => {
    const paneText = await deps.backend.capture(ref, CLASSIFIER_CAPTURE);
    const pane = {
      state: classify(paneText, deps.agent.rules),
      interrupted: deps.agent.rules.interrupted?.(paneText) ?? false,
      // Real, non-whitespace content (SGR stripped) — gates the drift canary so a
      // blank/gone pane is never judged as "all channels blind."
      nonEmpty: stripSgr(paneText).trim().length > 0,
    };
    return { belief: observer.belief(pane, weInterrupted), paneText };
  };

  return {
    name: deps.name,
    namespace: deps.namespace,
    ...(deps.agentSessionId === undefined ? {} : { agentSessionId: deps.agentSessionId }),
    send: (text) =>
      mutex.run(async () => {
        interruptPending = false; // a new turn supersedes any pending interrupt
        const beforeIds = new Set(observer.thread().messages.map((m) => m.id));
        await sendOnce(deps.backend, deps.agent, ref, text);
        // Anchor the cursor on OUR OWN user record, not a positional count.
        // A count read here is wrong: the PRIOR turn's reply may not have flushed
        // yet (the transcript trails the done signal by ~100ms), and a human may
        // type an interleaved turn. Anchoring on the record this send produced is
        // immune to both. Fall back to the sentinel only if it never appears.
        const ownId = await anchorOwnTurn(observer, beforeIds, text);
        if (ownId !== undefined) return ownId;
        // No user record appeared. A turn sent into a BUSY session is QUEUED by
        // the agent (accepted, runs next — do NOT re-send); report that distinctly
        // so the consumer doesn't double-run. The agent owns the "queued" pane
        // vocabulary; we just ask it.
        const pane = await deps.backend.capture(ref, CLASSIFIER_CAPTURE);
        if (deps.agent.rules.queued?.(pane)) return DELIVERED_QUEUED;
        // Lost-submit recovery — but ONLY when the pane looks like an un-submitted
        // DRAFT: it classifies `unknown` (a `❯ <text>` composer that is neither the
        // empty idle box nor the working spinner). That is the lost-Enter signature
        // — the paste reached the composer but the Enter didn't register. In that
        // one case re-fire Enter ONCE (submitOnce never re-pastes, so it cannot
        // duplicate the body) and re-anchor; the needle-match keeps it honest
        // (confirms a NEW record matching OUR text, never a stray draft).
        //
        // If the pane is `working`/`idle` instead, the submit already TOOK (or
        // there is nothing in the composer) and we merely couldn't anchor the
        // record — e.g. an adopted session whose transcript isn't locatable. Firing
        // a stray Enter there would inject a spurious empty turn, so we don't: the
        // honest answer is DELIVERY_UNCONFIRMED.
        if (classify(pane, deps.agent.rules) === "unknown") {
          await submitOnce(deps.backend, ref);
          const recovered = await anchorOwnTurn(observer, beforeIds, text, RETRY_ANCHOR_POLLS);
          if (recovered !== undefined) return recovered;
        }
        return DELIVERY_UNCONFIRMED;
      }),
    messagesSince: (cursor) => mutex.run(async () => messagesSince(observer, cursor)),
    turnComplete: (cursor) =>
      mutex.run(async () => messagesSince(observer, cursor).some((m) => m.role === "assistant")),
    progress: () =>
      mutex.run(async () => {
        const { belief } = await readBelief(interruptPending);
        // Project to the public Progress; the extra belief fields (interrupted /
        // edge timings) are wait()'s concern, not progress()'s.
        const {
          phase,
          toolInFlight,
          transcriptCount,
          hookChannelHealthy,
          agentChannelHealthy,
          state,
        } = belief;
        return {
          phase,
          toolInFlight,
          transcriptCount,
          hookChannelHealthy,
          agentChannelHealthy,
          state,
        } satisfies Progress;
      }),
    respond: (choice: PromptChoice) =>
      mutex.run(async () => {
        // Compose two sub-owners; own neither's internals. The AGENT owns the
        // menu option-order (choice→key) — no mapping ⇒ refuse rather than guess
        // a key (a wrong guess could pick "allow all"). The OBSERVER owns "is a
        // prompt still showing" — injected as the confirm predicate. The io
        // primitive owns delivery + settle.
        const key = deps.agent.permissionPrompt?.respondKey(choice);
        if (key === undefined) throw new PromptResponseUnsupported(deps.name, deps.agent.name);
        await respondOnce(
          deps.backend,
          ref,
          key,
          async () => (await readBelief(false)).belief.state === "permission-prompt",
        );
      }),
    interrupt: () =>
      mutex.run(async () => {
        interruptPending = true; // authoritative: we aborted; no `stop` will come
        await interruptOnce(deps.backend, ref);
      }),
    wait: (opts?: ReadyOpts) =>
      mutex.run(() => {
        // We issued an interrupt and haven't sent since — there is no turn to
        // wait for; report the abort rather than poll a frozen spinner to budget.
        if (interruptPending) return Promise.resolve<TurnOutcome>({ kind: "aborted" });
        return waitForOutcome(deps.backend, ref, opts ?? {}, { stabilize }, () =>
          readBelief(false),
        );
      }),
    state: () => mutex.run(async () => (await readBelief(interruptPending)).belief.state),
    capture: (opts) => mutex.run(() => deps.backend.capture(ref, opts)),
    kill: () => mutex.run(() => deps.backend.kill(ref)),
    onBackendCommand: (handler: (event: BackendCommandEvent) => void) =>
      deps.backend.onCommand(handler),
  } satisfies SessionHandle;
}

/** The hook rendezvous file: the one injected at spawn, else re-derived from the id. */
function rendezvousPath(deps: HandleDeps): string | undefined {
  if (deps.rendezvousPath !== undefined) return deps.rendezvousPath;
  return deps.agentSessionId === undefined ? undefined : rendezvousPathFor(deps.agentSessionId);
}

/**
 * The messages produced since `cursor` — the shared body of `messagesSince` and
 * `turnComplete`, read from the observer's incremental transcript cache. Causal
 * chain when the cursor is a real message id; clean positional slice for a legacy
 * numeric cursor; EMPTY for an unresolvable cursor (sentinel/garbage) — never the
 * whole transcript (F40).
 */
function messagesSince(observer: SessionObserver, cursor: string): Message[] {
  const { messages: all, parentOf } = observer.thread();
  if (all.some((m) => m.id === cursor)) return descendantsOf(all, parentOf, cursor);
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 && String(n) === cursor.trim() ? all.slice(n) : [];
}

/**
 * Messages causally after `ancestorId` — those whose parent chain passes through
 * it — in file order. Uses the thread links, not file position, so the prior
 * turn's late-flushing reply (which descends from an EARLIER user record) is
 * excluded even if it lands after our record in the append-only file. Records
 * with no parent chain (e.g. an agent that omits `parentId`) fall back to a
 * positional slice so a thread-less transcript still works.
 *
 * **Compaction-safe.** Verified empirically on claude 2.1.162: a compaction
 * (`/compact` or auto) summarizes the *context window* but leaves the on-disk
 * transcript append-only with an UNBROKEN linear `parentUuid` chain, so a
 * post-compaction turn still descends from a pre-compaction cursor — no special
 * handling needed for the observed case. As defense-in-depth against a future
 * record-format change (or a partial flush) that *did* drop an intermediate
 * record, a message whose chain hits a MISSING parent (orphaned, not a clean
 * root) and that sits positionally after the cursor is still included — we can't
 * prove causality through a hole, so we fall back to position. This cannot
 * re-include the late-flush prior reply: its parent record IS present (it roots
 * cleanly at an earlier turn), so it's never an orphan. (F43/F25.)
 */
function descendantsOf(
  all: readonly Message[],
  fullParentOf: Map<string, string | undefined>,
  ancestorId: string,
): Message[] {
  // Prefer the FULL ancestry graph (every record, incl. the non-message ones an
  // agent threads between a prompt and its reply). Without it — an agent with no
  // `parseEdge` — fall back to links between surfaced messages only.
  const parentOf =
    fullParentOf.size > 0 ? fullParentOf : new Map(all.map((m) => [m.id, m.parentId]));
  const hasLinks = [...parentOf.values()].some((p) => p !== undefined);
  const anchorIdx = all.findIndex((m) => m.id === ancestorId);
  if (!hasLinks) return anchorIdx >= 0 ? all.slice(anchorIdx + 1) : all.slice();
  // Classify a message's lineage relative to the cursor by walking its parent
  // chain: reaches the cursor → `descends`; hits a referenced-but-absent parent
  // → `orphan` (a hole, e.g. a dropped record); reaches a clean root (no parent)
  // → `rooted` (a different lineage — an earlier turn).
  const lineage = (id: string): "descends" | "orphan" | "rooted" => {
    const seen = new Set<string>();
    let cur = parentOf.get(id);
    while (cur !== undefined) {
      if (cur === ancestorId) return "descends";
      if (seen.has(cur)) return "rooted"; // cycle guard
      seen.add(cur);
      if (!parentOf.has(cur)) return "orphan"; // parent referenced but its record is gone
      cur = parentOf.get(cur);
    }
    return "rooted";
  };
  return all.filter((m, i) => {
    const l = lineage(m.id);
    return l === "descends" || (l === "orphan" && anchorIdx >= 0 && i > anchorIdx);
  });
}

const ANCHOR_POLLS = 12;
// The post-recovery re-anchor is shorter: a lost-Enter record appears within a
// poll or two of the retry Enter, so a true non-delivery still reports promptly
// rather than paying a second full anchor window.
const RETRY_ANCHOR_POLLS = 8;
const ANCHOR_POLL_MS = 250;
/** Collapse whitespace so a reflowed/echoed prompt still matches. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The id of the user record THIS send produced — a NEW (not pre-existing) user
 * message whose text matches what we sent. Polled because the record flushes
 * shortly after delivery; `undefined` if it never appears (a delivery problem).
 */
async function anchorOwnTurn(
  observer: SessionObserver,
  beforeIds: Set<string>,
  text: string,
  polls: number = ANCHOR_POLLS,
): Promise<string | undefined> {
  const needle = squash(text).slice(0, 80); // prefix tolerates echo reflow / truncation
  for (let attempt = 0; attempt < polls; attempt++) {
    const msgs = observer.thread().messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m === undefined || m.role !== "user" || beforeIds.has(m.id)) continue;
      if (m.parts.some((p) => p.kind === "text" && squash(p.text).includes(needle))) return m.id;
    }
    await sleep(ANCHOR_POLL_MS);
  }
  return undefined;
}

/**
 * Build a {@link SessionHandle} that points at an existing session, without
 * spawning or booting — the "attach to a live session" seam.
 *
 * Two public consumers: the stateless CLI reattaches through this on every
 * invocation, and the public `adopt()` primitive is built directly on it —
 * `adopt()` asserts the session EXISTS, then calls `attachHandle` (the
 * exists-asserting mirror of `create()`'s SessionExists guard). `create()`
 * remains the only path that *boots*; `attachHandle` is pure attach.
 */
export function attachHandle(deps: HandleDeps): SessionHandle {
  return makeHandle(deps);
}
