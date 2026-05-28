import { tmuxBackend } from "../backends/tmux/index.js";
import { defaultSocketName } from "../backends/tmux/socket.js";
import type { Backend } from "../backends/types.js";

/**
 * Resolve the socket name from the environment, falling back to the
 * substrate's default. Lives in this bootstrap module so the backend layer
 * (`backends/tmux/socket.ts`) stays a pure function — env composition is a
 * bootstrap concern, not a backend concern.
 */
function resolveSocketFromEnv(): string {
  const fromEnv = process.env.CLAUDEMUX_SOCKET;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return defaultSocketName();
}

/**
 * Process-wide default backend. Lazily constructed on first use so an
 * `import { exists } from "claudemux"` doesn't spawn a tmux server just by
 * loading the module.
 *
 * The socket name is **stable** (default `"claudemux"`, overridable via
 * `CLAUDEMUX_SOCKET`). Stability is load-bearing for the CLI: each
 * `claudemux <verb>` invocation is a cold Node process, and they must
 * discover each other's sessions. A per-process random socket would break
 * the entire CLI user journey — see `brain/initiatives/.../qa.md` §P0-1
 * and `brain/decisions/0006-default-backend-rendezvous-identity.md`.
 *
 * Internal — never exported from `src/index.ts`.
 */
let cached: Backend | null = null;

export function sharedDefaultBackend(): Backend {
  if (cached === null) {
    cached = tmuxBackend({ socket: resolveSocketFromEnv() });
  }
  return cached;
}

/**
 * Build a backend with an explicit socket name. Used by the CLI when the
 * caller passes `--socket <name>` to opt out of the process-wide shared
 * default. Each call returns a fresh instance (no caching) — the caller
 * owns the lifetime.
 */
export function backendWithSocket(socket: string): Backend {
  return tmuxBackend({ socket });
}

/** Test-only hook to reset the shared backend so each test gets a fresh socket. */
export function resetDefaultBackendForTesting(): void {
  cached = null;
}
