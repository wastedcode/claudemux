import { InvalidSessionName } from "../../errors.js";
import { validateNamePart } from "../../session/validate.js";
import {
  type Backend,
  type BackendEvent,
  type SendPayload,
  type SessionRef,
  formatSessionLabel,
} from "../types.js";
import { capturePane } from "./capture.js";
import { TmuxExec } from "./exec.js";
import { pasteText, sendKey } from "./keys.js";
import { getSessionOption, setSessionOption } from "./options.js";
import { hasSession, killSession, listSessions, newSession, targetOf } from "./sessions.js";

/**
 * Assemble the `Backend` implementation from the tmux subsystem.
 *
 * This file is the *only* place where the tmux backend's concrete pieces
 * compose into the seam contract — and the *only* place that bridges
 * `SessionRef` → the tmux target-name encoding (`<ns>--<name>`). Callers
 * outside `src/backends/tmux/**` never construct or parse target strings.
 *
 * **Validation policy (QA P1, 7360b35b):** name validation is a *mutating*
 * concern. `spawn` / `send` / `capture` reject reserved-char names with
 * `InvalidSessionName` (you cannot meaningfully write to / read from a name
 * the substrate can't address). But `exists` and `kill` are *query /
 * idempotent* verbs with total contracts — `exists` returns a boolean,
 * `kill` is a no-op on a missing session. A reserved-char name simply
 * *cannot* name a live session, so `exists` → `false` and `kill` → no-op,
 * rather than throwing and breaking those documented contracts.
 */
export function tmuxBackend(opts: { socket: string }): Backend {
  const exec = new TmuxExec(opts.socket);

  // Validate the ref + produce both the tmux-internal target and the public
  // label. Throws InvalidSessionName for reserved-char names — used by the
  // mutating/I-O verbs. Defense-in-depth: create() validates at the public
  // entry; a direct tmuxBackend caller could still bypass that.
  const refToTarget = (ref: SessionRef): { target: string; label: string } => {
    validateNamePart("namespace", ref.namespace);
    validateNamePart("name", ref.name);
    return { target: targetOf(ref.namespace, ref.name), label: formatSessionLabel(ref) };
  };

  // Non-throwing variant for the total query/idempotent verbs. Returns null
  // when the ref is invalid — an invalid name cannot name a live session.
  const tryRefToTarget = (ref: SessionRef): { target: string; label: string } | null => {
    try {
      return refToTarget(ref);
    } catch (err) {
      if (err instanceof InvalidSessionName) return null;
      throw err;
    }
  };

  // The mutating/I-O methods are `async` so a synchronous `validateNamePart`
  // throw becomes a promise *rejection* — consistent with their Promise
  // return type (a consumer's `.catch` / `await … rejects` works uniformly).
  return {
    id: "tmux",
    spawn: async (o) => {
      validateNamePart("namespace", o.namespace);
      validateNamePart("name", o.name);
      await newSession(exec, {
        namespace: o.namespace,
        name: o.name,
        cwd: o.cwd,
        ...(o.env ? { env: o.env } : {}),
        cmd: o.cmd,
        argv: o.argv,
        label: formatSessionLabel({ namespace: o.namespace, name: o.name }),
      });
    },
    kill: (ref) => {
      const t = tryRefToTarget(ref);
      if (t === null) return Promise.resolve(); // invalid name → nothing to kill
      return killSession(exec, t.target, t.label);
    },
    exists: (ref) => {
      const t = tryRefToTarget(ref);
      if (t === null) return Promise.resolve(false); // invalid name can't be alive
      return hasSession(exec, t.target, t.label);
    },
    list: async (namespace) => {
      validateNamePart("namespace", namespace);
      return listSessions(exec, namespace);
    },
    send: async (ref, payload: SendPayload) => {
      const { target, label } = refToTarget(ref);
      await (payload.kind === "paste"
        ? pasteText(exec, target, payload.text, label)
        : sendKey(exec, target, payload.key, label));
    },
    capture: async (ref, o) => {
      const { target, label } = refToTarget(ref);
      return capturePane(exec, target, { ...o, label });
    },
    setSessionMeta: async (ref, key, value) => {
      const { target, label } = refToTarget(ref);
      await setSessionOption(exec, target, key, value, label);
    },
    getSessionMeta: async (ref, key) => {
      // Total/best-effort, like exists/kill: an invalid name can't name a live
      // session, so it has no metadata — return undefined rather than throw.
      const t = tryRefToTarget(ref);
      if (t === null) return undefined;
      return getSessionOption(exec, t.target, key, t.label);
    },
    onCommand: (h: (e: BackendEvent) => void) => exec.onCommand(h),
  };
}
