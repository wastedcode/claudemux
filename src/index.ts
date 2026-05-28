/**
 * claudemux — drive long-lived Claude Code sessions from Node.
 *
 * Public re-exports only; the file carries no logic. Internal seams
 * (`Backend`, `BackendEvent`, `SendPayload`, `ClassifierRules`) stay
 * internal so the public API survives a backend swap without consumer
 * rewrites.
 */

export { claude } from "./agents/index.js";
export type { AgentDef, BootDialog } from "./agents/types.js";

export {
  BackendError,
  ClaudemuxError,
  DialogStuck,
  LoginRequired,
  PaneDead,
  ReplTimeout,
  SessionExists,
  SessionGone,
  BackendUnreachable,
} from "./errors.js";

export { create } from "./session/create.js";
export { exists, kill, list } from "./session/registry.js";

export type {
  BackendCommandEvent,
  ClientInfo,
  IdleState,
  ReadyOpts,
  SessionHandle,
  State,
} from "./types.js";
