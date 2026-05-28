import { tmuxBackend } from "../backends/tmux/index.js";
import { mintSocket } from "../backends/tmux/socket.js";
import type { Backend } from "../backends/types.js";

/**
 * Process-wide default backend. Lazily constructed on first use so an
 * `import { exists } from "claudemux"` doesn't spawn a tmux server just by
 * loading the module.
 *
 * Internal — never exported from `src/index.ts`. Consumers who want a
 * specific backend pass it explicitly via the `backend` option.
 */
let cached: Backend | null = null;

export function sharedDefaultBackend(): Backend {
  if (cached === null) {
    cached = tmuxBackend({ socket: mintSocket() });
  }
  return cached;
}

/** Test-only hook to reset the shared backend so each test gets a fresh socket. */
export function resetDefaultBackendForTesting(): void {
  cached = null;
}
