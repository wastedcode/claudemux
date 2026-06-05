import { create } from "../session/create.js";
import { type CommonOpts, backend, resolveAgent, resolveNamespace } from "./context.js";

export interface SpawnCliOpts extends CommonOpts {
  cwd: string;
  bootTimeoutMs?: number;
  extraArgs?: string[];
  trustWorkspace?: boolean;
}

/**
 * `claudemux spawn <name> --cwd <path>` — start a session and wait for ready.
 * Emits `{ "agentSessionId": "<id>" }` so a CLI user can persist the id and
 * later `claudemux resume <name2> <id>` (mirrors `send` emitting its cursor).
 */
export async function spawnCli(name: string, opts: SpawnCliOpts): Promise<void> {
  const session = await create({
    name,
    cwd: opts.cwd,
    backend: backend(opts),
    agent: resolveAgent(opts.agent),
    namespace: resolveNamespace(opts.namespace),
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
    ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
    ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
  });
  process.stdout.write(`${JSON.stringify({ agentSessionId: session.agentSessionId ?? null })}\n`);
}
