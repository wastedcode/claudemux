import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { DEFAULT_NAMESPACE } from "../session/constants.js";
import {
  backendWithSocket,
  resolveSocket,
  sharedDefaultBackend,
} from "../session/default-backend.js";
import { attachHandle } from "../session/handle.js";
import type { SessionHandle } from "../types.js";

/** Common options every CLI verb accepts. */
export interface CommonOpts {
  namespace?: string;
  agent?: string;
  /**
   * Explicit socket override. Precedence:
   *   `--socket <name>` flag > `CLAUDEMUX_SOCKET` env > default `"claudemux"`.
   */
  socket?: string;
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
export function backend(opts: CommonOpts = {}): Backend {
  if (opts.socket?.trim()) {
    return backendWithSocket(resolveSocket(opts.socket));
  }
  return sharedDefaultBackend();
}

/** Attach a session handle for an existing session — the CLI's reattach path. */
export function handleFor(o: CommonOpts & { name: string }): SessionHandle {
  return attachHandle({
    backend: backend(o),
    agent: resolveAgent(o.agent),
    namespace: resolveNamespace(o.namespace),
    name: o.name,
  });
}
