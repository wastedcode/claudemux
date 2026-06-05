import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { SessionExists } from "../errors.js";
import type { SessionHandle } from "../types.js";
import { formatSessionLabel } from "./ref.js";
import { resolveSessionContext } from "./resolve.js";
import { spawnBootHandle } from "./spawn-boot.js";
import { validateAgentSessionId } from "./validate.js";

/**
 * Options for {@link resume}. The peer of {@link CreateOptions} — same lifecycle
 * shape, except the conversation id is **given** (the one to continue), not
 * minted.
 */
export interface ResumeOptions {
  /** Session name within the namespace (a fresh pane is spawned under it). */
  name: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /**
   * The conversation to continue — an `agentSessionId` previously surfaced by
   * {@link create}/{@link adopt}. Validated as a v4 UUID before spawn. The agent
   * maps it to its own resume mechanism (claude: `--resume <id>`); the vendor
   * flag never appears in consumer code.
   */
  agentSessionId: string;
  /** Namespace prefix (default: `"claudemux"`). */
  namespace?: string;
  /** Agent definition (default: claude). */
  agent?: AgentDef;
  /** Backend instance (default: tmux on a fresh shared socket per process). */
  backend?: Backend;
  /** Extra args passed to the agent's argv. */
  extraArgs?: string[];
  /** Override env passed to the agent process. */
  env?: Record<string, string>;
  /** Boot timeout in ms (default 60_000). */
  bootTimeoutMs?: number;
  /** Opt in to auto-dismissing the workspace-trust dialog (default false). */
  trustWorkspace?: boolean;
  /** Inject the agent's observe hooks at spawn (default true). */
  hooks?: boolean;
}

/**
 * Resume an existing conversation in a **fresh pane** — the lifecycle peer of
 * {@link create} (start fresh) and {@link adopt} (re-attach to a *running*
 * pane). Use it after a crash, or to fork the conversation onto a new session:
 * pass the `agentSessionId` you persisted from a prior {@link create}/
 * {@link adopt}; the agent replays its history and you get a live handle.
 *
 * Composes the same spawn→boot→handle core as `create`; only identity differs
 * (an existing id → the agent's resume flag, vs a fresh mint → `--session-id`).
 *
 * @throws `InvalidAgentSessionId` if `agentSessionId` is not a v4 UUID
 *   (before spawn).
 * @throws `SessionExists` if a session with `{ namespace, name }` already exists
 *   — resume spawns a NEW pane and never silently adopts; pick an unused name,
 *   or {@link adopt} the running one.
 * @throws the same boot failures as {@link create}
 *   (`LoginRequired`/`WorkspaceUntrusted`/`DialogStuck`/`AgentExitedDuringBoot`/
 *   `ReplTimeout`). An `AgentExitedDuringBoot` here most often means the id is
 *   already live in another pane (claude refuses to resume an in-use id).
 *
 * @example
 * ```ts
 * import { create, resume } from "claudemux";
 * const s = await create({ name: "job", cwd });
 * const id = s.agentSessionId!;          // persist this
 * // …process restarts / crashes…
 * const r = await resume({ name: "job-2", cwd, agentSessionId: id });
 * ```
 */
export async function resume(opts: ResumeOptions): Promise<SessionHandle> {
  validateAgentSessionId(opts.agentSessionId);
  const { ref, agent, backend } = resolveSessionContext(opts);

  if (await backend.exists(ref)) {
    throw new SessionExists(formatSessionLabel(ref));
  }

  return spawnBootHandle({
    agent,
    backend,
    ref,
    cwd: opts.cwd,
    identity: { mode: "resume", agentSessionId: opts.agentSessionId },
    hooks: opts.hooks !== false,
    ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
    ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
  });
}
