import { tmuxBackend } from "../backends/tmux/index.js";
import { defaultSocketName } from "../backends/tmux/socket.js";
import type { Backend } from "../backends/types.js";

/**
 * Single-source socket-name resolution. Precedence (highest first):
 *
 *   `explicit` (`--socket` flag) > `CLAUDEMUX_SOCKET` env > `defaultSocketName()`
 *
 * Every candidate is **trimmed**, and the trimmed value is what's both gated
 * AND returned — so `" claudemux "` resolves to the same socket as the bare
 * default, instead of a silently-divergent `-L ' claudemux '` server that
 * re-opens the cross-process rendezvous bug the P0 fix closed (QA P2,
 * [[decisions/0006-default-backend-rendezvous-identity]]). A whitespace-only
 * value is treated as "not set" and falls through to the next candidate.
 *
 * Lives in this bootstrap module so the backend leaf
 * (`backends/tmux/socket.ts`) stays a pure function — env/flag composition
 * is a bootstrap concern, not a backend concern.
 */
export function resolveSocket(explicit?: string): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.CLAUDEMUX_SOCKET?.trim();
  if (fromEnv) return fromEnv;
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
    cached = tmuxBackend({ socket: resolveSocket() });
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
