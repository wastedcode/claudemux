/**
 * claudemux — drive long-lived Claude Code sessions from Node.
 *
 * Public re-exports only; the file carries no logic. Internal seams
 * (`Backend`, `BackendEvent`, `SendPayload`, `ClassifierRules`) stay
 * internal so the public API survives a backend swap without consumer
 * rewrites.
 */

export { claude } from "./agents/index.js";
export type { AgentDef, BootDialog, HookEdge } from "./agents/types.js";

export {
  AgentExitedDuringBoot,
  AgentSessionIdConflict,
  BackendError,
  BackendUnreachable,
  ClaudemuxError,
  DialogStuck,
  InvalidAgentSessionId,
  InvalidSessionName,
  LoginRequired,
  PaneDead,
  PromptResponseUnsupported,
  ReplTimeout,
  SessionExists,
  SessionGone,
  WorkspaceUntrusted,
} from "./errors.js";

export { ask } from "./compose.js";
export type { AskResult } from "./compose.js";
export { DELIVERY_UNCONFIRMED } from "./session/handle.js";
export { adopt } from "./session/adopt.js";
export type { AdoptOptions } from "./session/adopt.js";
export { create } from "./session/create.js";
export { exists, kill, list } from "./session/registry.js";
export { resume } from "./session/resume.js";
export type { ResumeOptions } from "./session/resume.js";

export type {
  BackendCommandEvent,
  ClientInfo,
  IdleState,
  Message,
  MessagePart,
  Progress,
  PromptChoice,
  ReadyOpts,
  SessionHandle,
  State,
  TurnOutcome,
} from "./types.js";
