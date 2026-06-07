import { resume } from "../session/resume.js";
import { type CommonOpts, backend, resolveAgent, resolveNamespace } from "./context.js";

export interface ResumeCliOpts extends CommonOpts {
  cwd: string;
  bootTimeoutMs?: number;
  extraArgs?: string[];
  trustWorkspace?: boolean;
}

/**
 * `claudemux resume <name> <agentSessionId> --cwd <path>` — continue an existing
 * conversation in a fresh pane. A thin face over the library {@link resume}.
 */
export async function resumeCli(
  name: string,
  agentSessionId: string,
  opts: ResumeCliOpts,
): Promise<void> {
  const session = await resume({
    name,
    agentSessionId,
    cwd: opts.cwd,
    backend: backend(opts),
    agent: resolveAgent(opts.agent),
    namespace: resolveNamespace(opts.namespace),
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
    ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
    ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
  });
  // Same shape as spawn — the resumed conversation id, for the next hop.
  process.stdout.write(`${JSON.stringify({ agentSessionId: session.agentSessionId ?? null })}\n`);
}
