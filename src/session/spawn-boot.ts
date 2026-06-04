import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import type { SessionHandle } from "../types.js";
import { bootSession } from "./boot.js";
import { AGENT_SESSION_ID_META_KEY } from "./constants.js";
import { makeHandle } from "./handle.js";
import { buildHookInjection } from "./hooks.js";
import { formatSessionLabel } from "./ref.js";

/**
 * How the conversation id is decided for a spawn — the ONLY thing that differs
 * between the lifecycle peers:
 *   - `fresh` (`create`): a minted or caller-chosen `sessionId` → `--session-id`.
 *   - `resume`: an existing `agentSessionId` → the agent's resume flag.
 */
export type SpawnIdentity =
  | { readonly mode: "fresh"; readonly sessionId: string; readonly explicit: boolean }
  | { readonly mode: "resume"; readonly agentSessionId: string };

/** The shared spawn→boot→handle input. `identity` carries the fresh/resume split. */
export interface SpawnBootInput {
  agent: AgentDef;
  backend: Backend;
  ref: SessionRef;
  cwd: string;
  identity: SpawnIdentity;
  /** Inject the agent's observe hooks at spawn. */
  hooks: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  trustWorkspace?: boolean;
}

/**
 * The shared lifecycle core for `create` (fresh) and `resume`: inject hooks,
 * build the argv (mapping the {@link SpawnIdentity}), spawn the pane, boot it,
 * cache the recoverable id, and return the handle. Both lifecycle faces compose
 * this ONE owner so the spawn/boot/handle decision lives in a single place;
 * they differ only in how identity is resolved before calling in.
 *
 * @throws the boot failures documented on {@link bootSession}; on any boot
 *   failure the just-spawned pane is killed (best-effort) before rethrowing.
 */
export async function spawnBootHandle(o: SpawnBootInput): Promise<SessionHandle> {
  // The id the hook rendezvous is keyed on (the conversation we'll run under).
  const idForHooks = o.identity.mode === "fresh" ? o.identity.sessionId : o.identity.agentSessionId;
  const injection = buildHookInjection({
    agent: o.agent,
    sessionId: idForHooks,
    enabled: o.hooks,
    userExtraArgs: o.extraArgs ?? [],
  });
  if (injection.rendezvousPath !== undefined) {
    mkdirSync(dirname(injection.rendezvousPath), { recursive: true });
  }
  const extraArgs = [...injection.args, ...(o.extraArgs ?? [])];

  const argvBuild = o.agent.buildArgv({
    cwd: o.cwd,
    sessionName: formatSessionLabel(o.ref),
    ...(o.identity.mode === "fresh"
      ? { sessionId: o.identity.sessionId, sessionIdExplicit: o.identity.explicit }
      : { resumeFrom: o.identity.agentSessionId }),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  });
  const agentSessionId = argvBuild.agentSessionId;
  const mergedEnv: Record<string, string> = { ...(argvBuild.env ?? {}), ...(o.env ?? {}) };
  await o.backend.spawn({
    namespace: o.ref.namespace,
    name: o.ref.name,
    cwd: o.cwd,
    env: mergedEnv,
    cmd: argvBuild.cmd,
    argv: argvBuild.argv,
  });

  // The caller-known id to attribute a boot-death to: the resume id, or an
  // explicitly-chosen fresh id (a minted v4 never collides, so omit it then).
  const knownId =
    o.identity.mode === "resume"
      ? o.identity.agentSessionId
      : o.identity.explicit
        ? o.identity.sessionId
        : undefined;
  try {
    await bootSession(o.backend, o.agent, o.ref, {
      cwd: o.cwd,
      ...(knownId === undefined ? {} : { agentSessionId: knownId }),
      ...(o.bootTimeoutMs === undefined ? {} : { timeoutMs: o.bootTimeoutMs }),
      ...(o.trustWorkspace === undefined ? {} : { trustWorkspace: o.trustWorkspace }),
      ...(injection.rendezvousPath === undefined
        ? {}
        : { rendezvousPath: injection.rendezvousPath }),
    });
  } catch (err) {
    await o.backend.kill(o.ref).catch(() => undefined);
    throw err;
  }

  // Best-effort: cache the id so adopt() can recover it after the process dies.
  // Never load-bearing (the id is already on the handle); a failure is ignored.
  if (agentSessionId !== undefined) {
    await o.backend
      .setSessionMeta(o.ref, AGENT_SESSION_ID_META_KEY, agentSessionId)
      .catch(() => undefined);
  }

  return makeHandle({
    backend: o.backend,
    agent: o.agent,
    namespace: o.ref.namespace,
    name: o.ref.name,
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(injection.rendezvousPath === undefined ? {} : { rendezvousPath: injection.rendezvousPath }),
  });
}
