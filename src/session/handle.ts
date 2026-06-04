import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { interruptOnce } from "../io/interrupt.js";
import { sendOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForState } from "../io/wait.js";
import { observeProgress, readMessages } from "../observe/observer.js";
import { classify } from "../state/classifier.js";
import type { BackendCommandEvent, Message, ReadyOpts, SessionHandle, State } from "../types.js";
import { sleep } from "../util/sleep.js";
import { CLASSIFIER_BOTTOM_N } from "./constants.js";
import { rendezvousPathFor } from "./hooks.js";
import { Mutex } from "./mutex.js";

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

  return {
    name: deps.name,
    namespace: deps.namespace,
    ...(deps.agentSessionId === undefined ? {} : { agentSessionId: deps.agentSessionId }),
    send: (text) =>
      mutex.run(async () => {
        const before = transcriptMessages(deps);
        const beforeIds = new Set(before.map((m) => m.id));
        await sendOnce(deps.backend, deps.agent, ref, text);
        // Anchor the cursor on OUR OWN user record, not a positional count.
        // A count read here is wrong: the PRIOR turn's reply may not have flushed
        // yet (the transcript trails the done signal by ~100ms), and a human may
        // type an interleaved turn. Anchoring on the record this send produced is
        // immune to both. Fall back to a count only if it never appears.
        const ownId = await anchorOwnTurn(deps, beforeIds, text);
        return ownId ?? String(before.length);
      }),
    messagesSince: (cursor) =>
      mutex.run(async () => {
        const all = transcriptMessages(deps);
        if (all.some((m) => m.id === cursor)) return descendantsOf(all, cursor);
        const n = Number.parseInt(cursor, 10); // legacy / delivery-unconfirmed fallback
        return Number.isFinite(n) && n >= 0 ? all.slice(n) : all;
      }),
    progress: () =>
      mutex.run(async () => {
        const rv = rendezvousPath(deps);
        const tp = transcriptPath(deps);
        return observeProgress({
          agent: deps.agent,
          ...(rv === undefined ? {} : { rendezvousPath: rv }),
          ...(tp === undefined ? {} : { transcriptPath: tp }),
        });
      }),
    interrupt: () => mutex.run(() => interruptOnce(deps.backend, ref)),
    wait: (opts?: ReadyOpts) =>
      mutex.run(() => waitForState(deps.backend, deps.agent, ref, opts ?? {}, { stabilize })),
    state: () => mutex.run(() => readState(deps.backend, deps.agent, ref)),
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

/** The agent's transcript file for this session, when locatable. */
function transcriptPath(deps: HandleDeps): string | undefined {
  if (deps.agent.transcript === undefined || deps.agentSessionId === undefined) return undefined;
  return deps.agent.transcript.locate({ agentSessionId: deps.agentSessionId }) ?? undefined;
}

/** All messages in the session transcript, or `[]` when it can't be located. */
function transcriptMessages(deps: HandleDeps): Message[] {
  const path = transcriptPath(deps);
  return path === undefined ? [] : readMessages({ agent: deps.agent, transcriptPath: path });
}

/**
 * Messages causally after `ancestorId` — those whose parent chain passes through
 * it — in file order. Uses the thread links, not file position, so the prior
 * turn's late-flushing reply (which descends from an EARLIER user record) is
 * excluded even if it lands after our record in the append-only file. Records
 * with no parent chain (e.g. an agent that omits `parentId`) fall back to a
 * positional slice so a thread-less transcript still works.
 */
function descendantsOf(all: Message[], ancestorId: string): Message[] {
  const parentOf = new Map(all.map((m) => [m.id, m.parentId]));
  const hasLinks = all.some((m) => m.parentId !== undefined);
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

async function readState(backend: Backend, agent: AgentDef, ref: SessionRef): Promise<State> {
  const text = await backend.capture(ref, { lines: CLASSIFIER_BOTTOM_N });
  return classify(text, agent.rules);
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
