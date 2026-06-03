import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { interruptOnce } from "../io/interrupt.js";
import { sendOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForState } from "../io/wait.js";
import { observeProgress, readMessages } from "../observe/observer.js";
import { classify } from "../state/classifier.js";
import type { BackendCommandEvent, Message, ReadyOpts, SessionHandle, State } from "../types.js";
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
        // Anchor the cursor BEFORE delivery so messagesSince() returns this
        // turn's output (a count into the append-only transcript).
        const cursor = String(transcriptMessages(deps).length);
        await sendOnce(deps.backend, deps.agent, ref, text);
        return cursor;
      }),
    messagesSince: (cursor) =>
      mutex.run(async () => {
        const all = transcriptMessages(deps);
        const n = Number.parseInt(cursor, 10);
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
