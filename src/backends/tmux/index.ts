import type { Backend, BackendEvent, SendPayload } from "../types.js";
import { capturePane } from "./capture.js";
import { TmuxExec } from "./exec.js";
import { pasteText, sendKey } from "./keys.js";
import { hasSession, killSession, listSessions, newSession, targetOf } from "./sessions.js";

/**
 * Assemble the `Backend` implementation from the tmux subsystem.
 *
 * This file is the *only* place where the tmux backend's concrete pieces
 * compose into the seam contract. Everything else in `src/backends/tmux/**`
 * is layer-local. The default export of this module is plugged into
 * `src/index.ts`'s `create()` as the backend default.
 */
export function tmuxBackend(opts: { socket: string }): Backend {
  const exec = new TmuxExec(opts.socket);
  return {
    id: "tmux",
    spawn: (o) => newSession(exec, o),
    kill: (name) => killSession(exec, name),
    exists: (name) => hasSession(exec, name),
    list: (namespace) =>
      listSessions(exec, namespace).then((shorts) => shorts.map((s) => targetOf(namespace, s))),
    send: (name, payload: SendPayload) =>
      payload.kind === "paste"
        ? pasteText(exec, name, payload.text)
        : sendKey(exec, name, payload.key),
    capture: (name, o) => capturePane(exec, name, o),
    onCommand: (h: (e: BackendEvent) => void) => exec.onCommand(h),
  };
}
