import { randomBytes } from "node:crypto";
import { SessionGone } from "../../errors.js";
import { type TmuxExec, classifyTmuxFailure } from "./exec.js";
import { hasSession } from "./sessions.js";

/**
 * Send a `paste` payload to a tmux session via `load-buffer + paste-buffer -p`.
 *
 * `-p` lets tmux emit bracketed-paste sequences if the receiver advertised
 * support — empirically verified byte-perfect end-to-end against a passive
 * sink on tmux 3.6 (see `docs/decisions/0001-tmux-paste-mechanism.md`). Body
 * line terminators normalize
 * to `\n` so claude (and other TUI agents that opt into bracketed paste)
 * see literal newlines inside the bracket, not stray `\r`s.
 *
 * **Does NOT auto-append Enter.** Submission is a separate `key` call. This
 * is the architectural lock-in from `engineer/wiki/tmux-private-server-bootstrap`'s
 * sibling page — multi-line input cannot leak around the seam because
 * `Backend.send` has no `sendRawText` primitive.
 *
 * **Pre-checks liveness.** `send-keys` returns exit 0 against a dead pane
 * (silent input drop trap — see `engineer/wiki/tmux-pane-death-detection`).
 * We check `has-session` first; if the session is gone, throw `SessionGone`
 * rather than letting the paste land in the void.
 *
 * `label` is the user-facing identifier used in error messages (defaults to
 * `target`); the wrapper in `tmuxBackend` passes the public label.
 */
export async function pasteText(
  exec: TmuxExec,
  target: string,
  text: string,
  label: string = target,
): Promise<void> {
  await ensureLive(exec, target, label);

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bufferName = `claudemux-${randomBytes(4).toString("hex")}`;

  {
    const args = ["load-buffer", "-b", bufferName, "-"];
    const r = await exec.run(args, { sessionName: label, input: normalized });
    const err = classifyTmuxFailure(label, ["tmux", ...args], r);
    if (err) throw err;
  }

  {
    const args = ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", target];
    const r = await exec.run(args, { sessionName: label });
    const err = classifyTmuxFailure(label, ["tmux", ...args], r);
    if (err) throw err;
  }
}

export async function sendKey(
  exec: TmuxExec,
  target: string,
  key: "Enter" | "Escape" | "1" | "2" | "y" | "n",
  label: string = target,
): Promise<void> {
  await ensureLive(exec, target, label);
  const args = ["send-keys", "-t", target, key];
  const r = await exec.run(args, { sessionName: label });
  const err = classifyTmuxFailure(label, ["tmux", ...args], r);
  if (err) throw err;
}

async function ensureLive(exec: TmuxExec, target: string, label: string): Promise<void> {
  if (!(await hasSession(exec, target, label))) {
    throw new SessionGone(label);
  }
}
