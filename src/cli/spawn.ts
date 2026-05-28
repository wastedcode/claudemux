import { create } from "../session/create.js";
import { type CommonOpts, backend, resolveAgent, resolveNamespace } from "./context.js";

export interface SpawnCliOpts extends CommonOpts {
  cwd: string;
  bootTimeoutMs?: number;
  extraArgs?: string[];
  trustWorkspace?: boolean;
}

/** `claudemux spawn <name> --cwd <path>` — start a session and wait for ready. */
export async function spawnCli(name: string, opts: SpawnCliOpts): Promise<void> {
  await create({
    name,
    cwd: opts.cwd,
    backend: backend(opts),
    agent: resolveAgent(opts.agent),
    namespace: resolveNamespace(opts.namespace),
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
    ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
    ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
  });
}
