import type { Backend } from "../backends/types.js";
import { DEFAULT_NAMESPACE } from "./constants.js";
import { sharedDefaultBackend } from "./default-backend.js";

/**
 * Bare `{ namespace, name }` operations for the public surface. Each
 * accepts an optional `backend` override; when omitted, the process-wide
 * default backend is used.
 */

/** Is the named session currently alive? */
export function exists(o: {
  name: string;
  namespace?: string;
  backend?: Backend;
}): Promise<boolean> {
  const backend = o.backend ?? sharedDefaultBackend();
  return backend.exists({ namespace: o.namespace ?? DEFAULT_NAMESPACE, name: o.name });
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
  return backend.kill({ namespace: o.namespace ?? DEFAULT_NAMESPACE, name: o.name });
}

/**
 * List short session names owned by `namespace`. Result is sorted for
 * stable test/UX behavior; the backend's order is not part of the
 * contract.
 */
export async function list(o: { namespace?: string; backend?: Backend } = {}): Promise<string[]> {
  const backend = o.backend ?? sharedDefaultBackend();
  const namespace = o.namespace ?? DEFAULT_NAMESPACE;
  const shortNames = await backend.list(namespace);
  return [...shortNames].sort();
}
