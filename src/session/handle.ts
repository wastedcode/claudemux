import type { AgentDef } from "../agents/types.js";
import { targetOf } from "../backends/tmux/sessions.js";
import type { Backend } from "../backends/types.js";
import { sendOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForState } from "../io/wait.js";
import { classify } from "../state/classifier.js";
import type { BackendCommandEvent, IdleState, ReadyOpts, SessionHandle, State } from "../types.js";
import { Mutex } from "./mutex.js";

/**
 * The classifier scans only the bottom-N lines of the pane to avoid
 * scrollback false-positives. 50 matches the boot window used in
 * `session/boot.ts`.
 */
const CLASSIFIER_BOTTOM_N = 50;

interface HandleDeps {
  backend: Backend;
  agent: AgentDef;
  namespace: string;
  name: string;
}

/**
 * Build a {@link SessionHandle} backed by a per-handle mutex. Every public
 * method that mutates or reads pane state goes through the mutex so
 * concurrent consumer calls cannot interleave bytes.
 */
export function makeHandle(deps: HandleDeps): SessionHandle {
  const target = targetOf(deps.namespace, deps.name);
  const mutex = new Mutex();

  return {
    name: deps.name,
    namespace: deps.namespace,
    send: (text) => mutex.run(() => sendOnce(deps.backend, target, text)),
    wait: (opts?: ReadyOpts) =>
      mutex.run(() => waitForState(deps.backend, deps.agent, target, opts ?? {}, { stabilize })),
    state: () => mutex.run(() => readState(deps.backend, deps.agent, target)),
    capture: (opts) => mutex.run(() => deps.backend.capture(target, opts)),
    kill: () => mutex.run(() => deps.backend.kill(target)),
    onBackendCommand: (handler: (event: BackendCommandEvent) => void) =>
      deps.backend.onCommand(handler),
  };
}

async function readState(backend: Backend, agent: AgentDef, target: string): Promise<State> {
  const text = await backend.capture(target, { lines: CLASSIFIER_BOTTOM_N });
  return classify(text, agent.rules);
}

// Re-export IdleState so callers building on this module can import without
// double-imports.
export type { IdleState };
