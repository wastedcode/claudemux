import { targetOf } from "../backends/tmux/sessions.js";
import type { Backend } from "../backends/types.js";

/**
 * Bare `{ namespace, name }` operations for callers who don't already hold
 * a {@link SessionHandle}. The CLI uses these for `exists` / `kill` / `list`;
 * library callers do too when they're checking on a session by name.
 */

/** Is the named session currently alive? */
export function existsByName(
  backend: Backend,
  o: { namespace: string; name: string },
): Promise<boolean> {
  return backend.exists(targetOf(o.namespace, o.name));
}

/**
 * Kill the named session. Idempotent — "kill of a missing session" is
 * success, not an error.
 */
export function killByName(
  backend: Backend,
  o: { namespace: string; name: string },
): Promise<void> {
  return backend.kill(targetOf(o.namespace, o.name));
}

/**
 * List short session names owned by `namespace`. The backend returns full
 * namespaced targets (e.g. `<ns>--<name>`); we strip the prefix so consumers
 * see only the short names they originally passed to `create`.
 */
export async function listByNamespace(backend: Backend, namespace: string): Promise<string[]> {
  const targets = await backend.list(namespace);
  const prefix = `${namespace}--`;
  return targets.map((t) => (t.startsWith(prefix) ? t.slice(prefix.length) : t)).sort();
}
