import { claude as defaultAgent } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { SessionExists } from "../errors.js";
import type { SessionHandle } from "../types.js";
import { DEFAULT_NAMESPACE } from "./constants.js";
import { sharedDefaultBackend } from "./default-backend.js";
import { formatSessionLabel } from "./ref.js";
import { spawnBootHandle } from "./spawn-boot.js";
import { validateAgentSessionId, validateNamePart } from "./validate.js";

/**
 * Options for {@link create}. The substrate provides sensible defaults so
 * the canonical call is `create({ name, cwd })`.
 */
export interface CreateOptions {
  /** Session name within the namespace. */
  name: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /** Namespace prefix (default: `"claudemux"`). Lets two consumers coexist. */
  namespace?: string;
  /** Agent definition (default: claude). */
  agent?: AgentDef;
  /** Backend instance (default: tmux on a fresh shared socket per process). */
  backend?: Backend;
  /** Extra args passed to the agent's argv. */
  extraArgs?: string[];
  /**
   * Choose the conversation id for this **fresh** session, instead of letting
   * the substrate mint one. Must be a v4 UUID (validated before spawn —
   * {@link InvalidAgentSessionId} otherwise). The chosen id is what
   * {@link SessionHandle.agentSessionId} reports. Leave unset for the common
   * case: the substrate mints a v4 UUID for you.
   *
   * Resume is **not** this option — use the first-class {@link resume} (or, for
   * an advanced case, an `extraArgs` `--resume <id>`). Passing both this and an
   * `extraArgs` identity flag (`--session-id` / `--resume` / `--fork-session`)
   * is a conflict → {@link AgentSessionIdConflict}.
   */
  agentSessionId?: string;
  /** Override env passed to the agent process. */
  env?: Record<string, string>;
  /** Boot timeout in ms (default 60_000). */
  bootTimeoutMs?: number;
  /**
   * Opt in to auto-dismissing the agent's workspace-trust dialog. Default
   * **false** (fail closed). When the agent asks to trust `cwd` and this is
   * not set, `create` throws `WorkspaceUntrusted` before any keystroke —
   * trusting a folder is an authority grant the substrate won't make
   * silently. See {@link WorkspaceUntrusted} for the persistent/global-trust
   * caveats before enabling it for untrusted-fork (PR-bot / CI) workloads.
   */
  trustWorkspace?: boolean;
  /**
   * Inject the agent's observe hooks at spawn (default **true**). Hooks give
   * claudemux deterministic, reliable turn-lifecycle insight without scraping
   * the TUI. Set `false` to opt out (e.g. you manage your own hooks); observe
   * then degrades to the best-effort pane+transcript fallback. The exact
   * injected settings are inspectable via the agent's hook spec.
   */
  hooks?: boolean;
}

/**
 * Create a new session: spawn the agent, dismiss boot dialogs, wait for
 * ready, return a handle.
 *
 * @throws `SessionExists` if a session with the same `{ namespace, name }`
 *   already exists — the substrate never silently adopts.
 * @throws `InvalidAgentSessionId` if `agentSessionId` is supplied but is not a
 *   v4 UUID (thrown before spawn).
 * @throws `AgentSessionIdConflict` if `agentSessionId` is supplied alongside an
 *   `extraArgs` identity flag (`--session-id` / `--resume` / `--fork-session`)
 *   — the id was chosen two ways (thrown before spawn).
 * @throws `LoginRequired` if claude's login-method dialog fires (the
 *   consumer must `claude auth` first).
 * @throws `WorkspaceUntrusted` if the agent asks to trust `cwd` and
 *   `trustWorkspace` was not set (thrown before any keystroke).
 * @throws `DialogStuck` if a recognized boot dialog persists after its
 *   response.
 * @throws `AgentExitedDuringBoot` if the agent exits before becoming ready —
 *   most often an `agentSessionId` collision (the agent refuses to silently
 *   resume an in-use id and exits). The id is carried on the error.
 * @throws `ReplTimeout` if the boot budget elapses before ready.
 *
 * @example
 * ```ts
 * import { create, claude } from "claudemux";
 * const session = await create({ name: "job", cwd: process.cwd() });
 * await session.send("Add a CHANGELOG entry");
 * await session.wait();
 * const text = await session.capture();
 * ```
 */
export async function create(opts: CreateOptions): Promise<SessionHandle> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  validateNamePart("namespace", namespace);
  validateNamePart("name", opts.name);
  const agent = opts.agent ?? defaultAgent;
  const backend = opts.backend ?? sharedDefaultBackend();
  const ref: SessionRef = { namespace, name: opts.name };

  // Exists-check first. Never silently adopt an existing session — that is
  // the lifecycle-policy footgun claudemux explicitly avoids.
  if (await backend.exists(ref)) {
    throw new SessionExists(formatSessionLabel(ref));
  }

  // Resolve the FRESH conversation id. The mint is neutral (crypto.randomUUID —
  // no agent vocabulary); a caller-supplied id is validated as a v4 UUID. The
  // agent's buildArgv decides how it becomes a flag and returns the id that will
  // actually run, which `spawnBootHandle` surfaces (single source of truth).
  const explicit = opts.agentSessionId !== undefined;
  if (explicit) {
    validateAgentSessionId(opts.agentSessionId as string);
  }
  const sessionId = explicit ? (opts.agentSessionId as string) : crypto.randomUUID();

  return spawnBootHandle({
    agent,
    backend,
    ref,
    cwd: opts.cwd,
    identity: { mode: "fresh", sessionId, explicit },
    hooks: opts.hooks !== false,
    ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: opts.bootTimeoutMs }),
    ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
  });
}
