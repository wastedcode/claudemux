import type { Backend, BackendEvent, SendPayload, SessionRef } from "../types.js";
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
  const tgt = (ref: SessionRef) => targetOf(ref.namespace, ref.name);
  return {
    id: "tmux",
    spawn: (o) =>
      newSession(exec, {
        namespace: o.namespace,
        name: o.name,
        cwd: o.cwd,
        ...(o.env ? { env: o.env } : {}),
        cmd: o.cmd,
        argv: o.argv,
      }),
    kill: (ref) => killSession(exec, tgt(ref)),
    exists: (ref) => hasSession(exec, tgt(ref)),
    list: (namespace) => listSessions(exec, namespace),
    send: (ref, payload: SendPayload) =>
      payload.kind === "paste"
        ? pasteText(exec, tgt(ref), payload.text)
        : sendKey(exec, tgt(ref), payload.key),
    capture: (ref, o) => capturePane(exec, tgt(ref), o),
    onCommand: (h: (e: BackendEvent) => void) => exec.onCommand(h),
  };
}
