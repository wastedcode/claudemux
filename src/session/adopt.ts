import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { SessionGone } from "../errors.js";
import type { SessionHandle } from "../types.js";
import { AGENT_SESSION_ID_META_KEY } from "./constants.js";
import { attachHandle } from "./handle.js";
import { formatSessionLabel } from "./ref.js";
import { resolveSessionContext } from "./resolve.js";

/**
 * Options for {@link adopt}. Mirrors {@link CreateOptions} minus the spawn-only
 * fields (`cwd`, `extraArgs`, `env`, `bootTimeoutMs`, `trustWorkspace`) — adopt
 * neither spawns nor boots.
 */
export interface AdoptOptions {
  /** Name of the session to re-adopt; must match the live session's name. */
  name: string;
  /** Namespace prefix (default: `"claudemux"`). Must match the live session's namespace. */
  namespace?: string;
  /**
   * Agent definition controlling state/idle classification (default: claude).
   * MUST be the same agent the original `create()` used — the classifier reads
   * THIS agent's `rules`, not the session's. Passing the wrong agent silently
   * misclassifies `state()`/`wait()`. See README §adopt.
   */
  agent?: AgentDef;
  /** Backend the live session runs in (default: the process-wide shared default — stable socket). */
  backend?: Backend;
}

/**
 * Re-adopt a session that is already live but was created by another process —
 * the mirror of {@link create}. Pure attach: no spawn, no boot, no dialog dismissal.
 *
 * After a successful adopt the consumer MUST call `state()` before driving the
 * pane (covers wedged / mid-dialog). See README §adopt for the A/B/C recovery
 * taxonomy and the single-writer invariant.
 *
 * @throws `InvalidSessionName` if `name`/`namespace` contain reserved characters
 *   (thrown before the exists-check).
 * @throws `SessionGone` if no such session exists — incl. the whole backend
 *   server being down, which `exists()` reports as absence.
 *
 * @example
 * ```ts
 * import { adopt, SessionGone } from "claudemux";
 * try {
 *   const session = await adopt({ name: "job" });
 *   await session.state(); // ALWAYS call state() before driving the pane
 * } catch (err) {
 *   if (err instanceof SessionGone) {
 *     // the pane is gone — continue the conversation in a fresh one:
 *     // await resume({ name: "job-2", cwd, agentSessionId });
 *   }
 * }
 * ```
 */
export async function adopt(opts: AdoptOptions): Promise<SessionHandle> {
  const { ref, agent, backend } = resolveSessionContext(opts);

  // Mirror of create()'s exists-check, inverted. adopt REQUIRES the session to
  // be present; absence (including whole-server-down, which exists() collapses
  // to false) is SessionGone — the symmetric counterpart to SessionExists.
  if (!(await backend.exists(ref))) {
    throw new SessionGone(formatSessionLabel(ref));
  }

  // Best-effort: recover the agent's conversation id from the session-meta the
  // creating process cached. `undefined` on a miss (older/non-claudemux session,
  // a creator that never wrote it, or a store read failure) — adopt never
  // fabricates an id, it tells the truth and lets the consumer fall back to its
  // own store. getSessionMeta already collapses "unreadable" to `undefined`.
  const agentSessionId = await backend.getSessionMeta(ref, AGENT_SESSION_ID_META_KEY);

  // Pure attach — no spawn, no boot, no dialog dismissal. The consumer MUST call
  // state() after adopt to learn where the live pane stands.
  return attachHandle({
    backend,
    agent,
    namespace: ref.namespace,
    name: ref.name,
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
  });
}
