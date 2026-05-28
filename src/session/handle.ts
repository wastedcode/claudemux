import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { sendOnce } from "../io/send.js";
import { stabilize } from "../io/stabilize.js";
import { waitForState } from "../io/wait.js";
import { classify } from "../state/classifier.js";
import type { BackendCommandEvent, ReadyOpts, SessionHandle, State } from "../types.js";
import { CLASSIFIER_BOTTOM_N } from "./constants.js";
import { Mutex } from "./mutex.js";

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
  const ref: SessionRef = { namespace: deps.namespace, name: deps.name };
  const mutex = new Mutex();

  return {
    name: deps.name,
    namespace: deps.namespace,
    send: (text) => mutex.run(() => sendOnce(deps.backend, ref, text)),
    wait: (opts?: ReadyOpts) =>
      mutex.run(() => waitForState(deps.backend, deps.agent, ref, opts ?? {}, { stabilize })),
    state: () => mutex.run(() => readState(deps.backend, deps.agent, ref)),
    capture: (opts) => mutex.run(() => deps.backend.capture(ref, opts)),
    kill: () => mutex.run(() => deps.backend.kill(ref)),
    onBackendCommand: (handler: (event: BackendCommandEvent) => void) =>
      deps.backend.onCommand(handler),
  };
}

async function readState(backend: Backend, agent: AgentDef, ref: SessionRef): Promise<State> {
  const text = await backend.capture(ref, { lines: CLASSIFIER_BOTTOM_N });
  return classify(text, agent.rules);
}
