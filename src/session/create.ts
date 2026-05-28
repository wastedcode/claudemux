import { claude as defaultAgent } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { SessionExists } from "../errors.js";
import type { SessionHandle } from "../types.js";
import { bootSession } from "./boot.js";
import { DEFAULT_NAMESPACE } from "./constants.js";
import { sharedDefaultBackend } from "./default-backend.js";
import { makeHandle } from "./handle.js";
import { formatSessionLabel } from "./ref.js";
import { validateNamePart } from "./validate.js";

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
}

/**
 * Create a new session: spawn the agent, dismiss boot dialogs, wait for
 * ready, return a handle.
 *
 * @throws `SessionExists` if a session with the same `{ namespace, name }`
 *   already exists — the substrate never silently adopts.
 * @throws `LoginRequired` if claude's login-method dialog fires (the
 *   consumer must `claude auth` first).
 * @throws `WorkspaceUntrusted` if the agent asks to trust `cwd` and
 *   `trustWorkspace` was not set (thrown before any keystroke).
 * @throws `DialogStuck` if a recognized boot dialog persists after its
 *   response.
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

  const argvBuild = agent.buildArgv({
    cwd: opts.cwd,
    ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
  });
  const mergedEnv: Record<string, string> = { ...(argvBuild.env ?? {}), ...(opts.env ?? {}) };
  await backend.spawn({
    namespace,
    name: opts.name,
    cwd: opts.cwd,
    env: mergedEnv,
    cmd: argvBuild.cmd,
    argv: argvBuild.argv,
  });

  try {
    await bootSession(backend, agent, ref, {
      cwd: opts.cwd,
      ...(opts.bootTimeoutMs === undefined ? {} : { timeoutMs: opts.bootTimeoutMs }),
      ...(opts.trustWorkspace === undefined ? {} : { trustWorkspace: opts.trustWorkspace }),
    });
  } catch (err) {
    await backend.kill(ref).catch(() => undefined);
    throw err;
  }

  return makeHandle({ backend, agent, namespace, name: opts.name });
}
