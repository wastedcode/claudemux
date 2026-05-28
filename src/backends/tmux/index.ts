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
import { hasSession, killSession, listSessions, newSession, targetOf } from "./sessions.js";

/**
 * Assemble the `Backend` implementation from the tmux subsystem.
 *
 * This file is the *only* place where the tmux backend's concrete pieces
 * compose into the seam contract — and the *only* place that bridges
 * `SessionRef` → the tmux target-name encoding (`<ns>--<name>`). Callers
 * outside `src/backends/tmux/**` never construct or parse target strings.
 */
export function tmuxBackend(opts: { socket: string }): Backend {
  const exec = new TmuxExec(opts.socket);
  // Validate the ref + produce both the tmux-internal target and the
  // public label. Defense-in-depth: `create()` validates at the public
  // entry; a direct `tmuxBackend.spawn()` caller could still bypass that.
  const refToTarget = (ref: SessionRef): { target: string; label: string } => {
    validateNamePart("namespace", ref.namespace);
    validateNamePart("name", ref.name);
    return {
      target: targetOf(ref.namespace, ref.name),
      label: formatSessionLabel(ref),
    };
  };
  return {
    id: "tmux",
    spawn: (o) => {
      validateNamePart("namespace", o.namespace);
      validateNamePart("name", o.name);
      return newSession(exec, {
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
      const { target, label } = refToTarget(ref);
      return killSession(exec, target, label);
    },
    exists: (ref) => {
      const { target, label } = refToTarget(ref);
      return hasSession(exec, target, label);
    },
    list: (namespace) => {
      validateNamePart("namespace", namespace);
      return listSessions(exec, namespace);
    },
    send: (ref, payload: SendPayload) => {
      const { target, label } = refToTarget(ref);
      return payload.kind === "paste"
        ? pasteText(exec, target, payload.text, label)
        : sendKey(exec, target, payload.key, label);
    },
    capture: (ref, o) => {
      const { target, label } = refToTarget(ref);
      return capturePane(exec, target, { ...o, label });
    },
    onCommand: (h: (e: BackendEvent) => void) => exec.onCommand(h),
  };
}
