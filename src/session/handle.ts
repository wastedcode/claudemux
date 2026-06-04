import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { interruptOnce } from "../io/interrupt.js";
import { sendOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForOutcome } from "../io/wait.js";
import {
  type Belief,
  assembleBelief,
  readMessages,
  readThread,
  resolveTranscriptPath,
} from "../observe/observer.js";
import { classify } from "../state/classifier.js";
import type {
  BackendCommandEvent,
  Message,
  Progress,
  ReadyOpts,
  SessionHandle,
  TurnOutcome,
} from "../types.js";
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

  return {
    name: deps.name,
    namespace: deps.namespace,
    ...(deps.agentSessionId === undefined ? {} : { agentSessionId: deps.agentSessionId }),
    send: (text) =>
      mutex.run(async () => {
        interruptPending = false; // a new turn supersedes any pending interrupt
        const before = transcriptMessages(deps);
        const beforeIds = new Set(before.map((m) => m.id));
        await sendOnce(deps.backend, deps.agent, ref, text);
        // Anchor the cursor on OUR OWN user record, not a positional count.
        // A count read here is wrong: the PRIOR turn's reply may not have flushed
        // yet (the transcript trails the done signal by ~100ms), and a human may
        // type an interleaved turn. Anchoring on the record this send produced is
        // immune to both. Fall back to a count only if it never appears.
        const ownId = await anchorOwnTurn(deps, beforeIds, text);
        return ownId ?? DELIVERY_UNCONFIRMED; // no anchor → unconfirmed (never a count)
      }),
    messagesSince: (cursor) => mutex.run(async () => messagesSince(deps, cursor)),
    turnComplete: (cursor) =>
      mutex.run(async () => messagesSince(deps, cursor).some((m) => m.role === "assistant")),
    progress: () =>
      mutex.run(async () => {
        const b = await readBelief(deps, ref, interruptPending);
        // Project the belief to the public Progress; the extra belief fields
        // (interrupted / edge timings) are wait()'s concern, not progress()'s.
        const { phase, toolInFlight, transcriptCount, hookChannelHealthy, state } = b;
        return {
          phase,
          toolInFlight,
          transcriptCount,
          hookChannelHealthy,
          state,
        } satisfies Progress;
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
        const rv = rendezvousPath(deps);
        const tp = transcriptPath(deps);
        return waitForOutcome(
          deps.backend,
          deps.agent,
          ref,
          {
            ...(rv === undefined ? {} : { rendezvousPath: rv }),
            ...(tp === undefined ? {} : { transcriptPath: tp }),
          },
          opts ?? {},
          { stabilize },
        );
      }),
    state: () => mutex.run(async () => (await readBelief(deps, ref, interruptPending)).state),
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
 * The agent's transcript file for this session, when locatable. Prefers the
 * authoritative path the hook reported (via the Observer) over the fragile glob.
 */
function transcriptPath(deps: HandleDeps): string | undefined {
  const rv = rendezvousPath(deps);
  return (
    resolveTranscriptPath({
      agent: deps.agent,
      ...(rv === undefined ? {} : { rendezvousPath: rv }),
      ...(deps.agentSessionId === undefined ? {} : { agentSessionId: deps.agentSessionId }),
    }) ?? undefined
  );
}

/** All messages in the session transcript, or `[]` when it can't be located. */
function transcriptMessages(deps: HandleDeps): Message[] {
  const path = transcriptPath(deps);
  return path === undefined ? [] : readMessages({ agent: deps.agent, transcriptPath: path });
}

/**
 * The messages produced since `cursor` — the shared body of `messagesSince` and
 * `turnComplete`. Causal-chain when the cursor is a real message id; positional /
 * count fallback for a legacy or delivery-unconfirmed cursor.
 */
function messagesSince(deps: HandleDeps, cursor: string): Message[] {
  const { messages: all, parentOf } = transcriptThread(deps);
  if (all.some((m) => m.id === cursor)) return descendantsOf(all, parentOf, cursor);
  // An explicit, *clean* positional cursor still slices (legacy, non-durable —
  // positions shift as the transcript grows). Anything else — the
  // DELIVERY_UNCONFIRMED sentinel, a stale/garbage cursor — reads EMPTY, never
  // the whole transcript. A cursor that can't be resolved must not flood (F40).
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 && String(n) === cursor.trim() ? all.slice(n) : [];
}

/** Messages + the full ancestry graph (bridges non-message records), or empty. */
function transcriptThread(deps: HandleDeps): {
  messages: Message[];
  parentOf: Map<string, string | undefined>;
} {
  const path = transcriptPath(deps);
  return path === undefined
    ? { messages: [], parentOf: new Map() }
    : readThread({ agent: deps.agent, transcriptPath: path });
}

/**
 * Messages causally after `ancestorId` — those whose parent chain passes through
 * it — in file order. Uses the thread links, not file position, so the prior
 * turn's late-flushing reply (which descends from an EARLIER user record) is
 * excluded even if it lands after our record in the append-only file. Records
 * with no parent chain (e.g. an agent that omits `parentId`) fall back to a
 * positional slice so a thread-less transcript still works.
 */
function descendantsOf(
  all: Message[],
  fullParentOf: Map<string, string | undefined>,
  ancestorId: string,
): Message[] {
  // Prefer the FULL ancestry graph (every record, incl. the non-message ones an
  // agent threads between a prompt and its reply). Without it — an agent with no
  // `parseEdge` — fall back to links between surfaced messages only.
  const parentOf =
    fullParentOf.size > 0 ? fullParentOf : new Map(all.map((m) => [m.id, m.parentId]));
  const hasLinks = [...parentOf.values()].some((p) => p !== undefined);
  if (!hasLinks) {
    const idx = all.findIndex((m) => m.id === ancestorId);
    return idx >= 0 ? all.slice(idx + 1) : all;
  }
  const descends = (id: string): boolean => {
    const seen = new Set<string>();
    let cur = parentOf.get(id);
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  return all.filter((m) => descends(m.id));
}

const ANCHOR_POLLS = 12;
const ANCHOR_POLL_MS = 250;
/** Collapse whitespace so a reflowed/echoed prompt still matches. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The id of the user record THIS send produced — a NEW (not pre-existing) user
 * message whose text matches what we sent. Polled because the record flushes
 * shortly after delivery; `undefined` if it never appears (a delivery problem).
 */
async function anchorOwnTurn(
  deps: HandleDeps,
  beforeIds: Set<string>,
  text: string,
): Promise<string | undefined> {
  const needle = squash(text).slice(0, 80); // prefix tolerates echo reflow / truncation
  for (let attempt = 0; attempt < ANCHOR_POLLS; attempt++) {
    const msgs = transcriptMessages(deps);
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
 * Read the one fused {@link Belief} — the single owner `state()`/`progress()`
 * defer to. Captures + classifies the pane, then fuses with the hook edges +
 * transcript via {@link assembleBelief}. A capture failure is **not** swallowed:
 * in tmux a failed capture means the session/server is gone (a terminal
 * condition), so the typed `SessionGone`/`BackendUnreachable` propagates — the
 * caller asked about a session that no longer exists, and should hear so.
 */
async function readBelief(
  deps: HandleDeps,
  ref: SessionRef,
  weInterrupted: boolean,
): Promise<Belief> {
  const text = await deps.backend.capture(ref, CLASSIFIER_CAPTURE);
  const pane = {
    state: classify(text, deps.agent.rules),
    interrupted: deps.agent.rules.interrupted?.(text) ?? false,
  };
  const rv = rendezvousPath(deps);
  const tp = transcriptPath(deps);
  return assembleBelief({
    agent: deps.agent,
    ...(rv === undefined ? {} : { rendezvousPath: rv }),
    ...(tp === undefined ? {} : { transcriptPath: tp }),
    pane,
    weInterrupted,
  });
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
