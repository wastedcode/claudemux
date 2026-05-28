import { targetOf } from "../backends/tmux/sessions.js";
import type { Backend } from "../backends/types.js";
import { sharedDefaultBackend } from "./default-backend.js";

/**
 * Bare `{ namespace, name }` operations for the public surface. Each
 * accepts an optional `backend` override; when omitted, the process-wide
 * default backend is used.
 */

const DEFAULT_NAMESPACE = "claudemux";

/** Is the named session currently alive? */
export function exists(o: {
  name: string;
  namespace?: string;
  backend?: Backend;
}): Promise<boolean> {
  const backend = o.backend ?? sharedDefaultBackend();
  const namespace = o.namespace ?? DEFAULT_NAMESPACE;
  return backend.exists(targetOf(namespace, o.name));
}

/**
 * Kill the named session. Idempotent — "kill of a missing session" is
 * success, not an error.
 */
export function kill(o: {
  name: string;
  namespace?: string;
  backend?: Backend;
}): Promise<void> {
  const backend = o.backend ?? sharedDefaultBackend();
  const namespace = o.namespace ?? DEFAULT_NAMESPACE;
  return backend.kill(targetOf(namespace, o.name));
}

/**
 * List short session names owned by `namespace`. The backend returns full
 * namespaced targets (e.g. `<ns>--<name>`); we strip the prefix so consumers
 * see only the short names they originally passed to `create`.
 */
export async function list(o: { namespace?: string; backend?: Backend } = {}): Promise<string[]> {
  const backend = o.backend ?? sharedDefaultBackend();
  const namespace = o.namespace ?? DEFAULT_NAMESPACE;
  const targets = await backend.list(namespace);
  const prefix = `${namespace}--`;
  return targets.map((t) => (t.startsWith(prefix) ? t.slice(prefix.length) : t)).sort();
}
