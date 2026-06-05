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
import type { ReadyOpts, SessionHandle } from "../types.js";

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
 * Resolve the agent by short name. Only `claude` is supported currently;
 * any other value exits with a typed error message.
 */
export function resolveAgent(name: string | undefined): AgentDef {
  const key = name ?? "claude";
  if (key !== "claude") {
    process.stderr.write(`claudemux: unknown agent "${key}" — only "claude" is supported\n`);
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

/** Wait-patience flags shared by `wait` and `ask`. */
export interface PatienceCliOpts {
  /** `--timeout-ms` — wall-clock cap (maps to {@link ReadyOpts.maxMs}). */
  timeoutMs?: number;
  /** `--idle-ms` — no-progress cap (maps to {@link ReadyOpts.idleMs}). */
  idleMs?: number;
}

/** The CLI's own default wall-clock cap. */
const CLI_DEFAULT_MAX_MS = 300_000;

/**
 * Build the library's {@link ReadyOpts} from CLI patience flags. The library
 * imposes **no** default patience; the CLI is a *consumer* and supplies its own
 * so a shell `wait`/`ask` can't hang forever: if neither bound is given it caps
 * the wall-clock at {@link CLI_DEFAULT_MAX_MS}. `--timeout-ms` and `--idle-ms`
 * override; passing `--idle-ms` alone opts out of the wall-clock default (the
 * caller chose a no-progress bound deliberately).
 */
export function patienceOpts(o: PatienceCliOpts): ReadyOpts {
  const maxMs = o.timeoutMs ?? (o.idleMs === undefined ? CLI_DEFAULT_MAX_MS : undefined);
  return {
    ...(maxMs === undefined ? {} : { maxMs }),
    ...(o.idleMs === undefined ? {} : { idleMs: o.idleMs }),
  };
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
