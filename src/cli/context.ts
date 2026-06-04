import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { adopt } from "../session/adopt.js";
import { DEFAULT_NAMESPACE } from "../session/constants.js";
import {
  backendWithSocket,
  resolveSocket,
  sharedDefaultBackend,
} from "../session/default-backend.js";
import type { SessionHandle } from "../types.js";

/**
 * Options to **locate** a session — every verb takes these. Mirrors the
 * `common()` helper in `main.ts` (namespace + socket, no agent).
 */
export interface RefOpts {
  namespace?: string;
  /**
   * Explicit socket override. Precedence:
   *   `--socket <name>` flag > `CLAUDEMUX_SOCKET` env > default `"claudemux"`.
   */
  socket?: string;
}

/**
 * {@link RefOpts} plus the agent — for verbs that build a session handle.
 * Mirrors the `withAgent()` helper. Registry verbs (kill/list/exists) take only
 * {@link RefOpts}, so the two types track the two helpers exactly.
 */
export interface CommonOpts extends RefOpts {
  agent?: string;
}

/**
 * Resolve the agent by short name. Only `claude` is supported in v0.0.1;
 * any other value exits with a typed error message.
 */
export function resolveAgent(name: string | undefined): AgentDef {
  const key = name ?? "claude";
  if (key !== "claude") {
    process.stderr.write(
      `claudemux: unknown agent "${key}" — only "claude" is supported in v0.0.1\n`,
    );
    process.exit(2);
  }
  return claude;
}

/** Resolve the namespace, applying the substrate's default. */
export function resolveNamespace(name: string | undefined): string {
  return name ?? DEFAULT_NAMESPACE;
}

/**
 * Resolve the backend for this CLI invocation. If `--socket` was passed
 * (and is non-empty after trimming), builds a fresh backend on the
 * resolved socket; otherwise returns the process-wide shared default
 * (which itself honors `CLAUDEMUX_SOCKET`). The trim → gate-and-return
 * consistency lives in `resolveSocket` so a padded `--socket ' x '` lands
 * on the same server as `--socket x`.
 */
export function backend(opts: RefOpts = {}): Backend {
  if (opts.socket?.trim()) {
    return backendWithSocket(resolveSocket(opts.socket));
  }
  return sharedDefaultBackend();
}

/**
 * Attach a session handle for the CLI's per-invocation reattach. Delegates to
 * the library {@link adopt} — the ONE owner of "re-attach to a running session"
 * — so the CLI **recovers the agentSessionId** (and thus can locate the
 * transcript + hook rendezvous) instead of reimplementing a weaker attach.
 * Async because recovery reads session metadata.
 *
 * @throws `SessionGone` if the named session is not alive (adopt's contract) —
 *   the CLI surfaces it as a typed, no-tmux-leak error.
 */
export function handleFor(o: CommonOpts & { name: string }): Promise<SessionHandle> {
  return adopt({
    backend: backend(o),
    agent: resolveAgent(o.agent),
    namespace: resolveNamespace(o.namespace),
    name: o.name,
  });
}

/** Read all of stdin as UTF-8 — the `<text>` = `"-"` piping convention. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
