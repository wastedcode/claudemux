import { randomBytes } from "node:crypto";
import { SessionGone } from "../../errors.js";
import { type TmuxExec, classifyTmuxFailure } from "./exec.js";
import { hasSession } from "./sessions.js";

/**
 * Send a `paste` payload to a tmux session via `load-buffer + paste-buffer -p`.
 *
 * `-p` lets tmux emit bracketed-paste sequences if the receiver advertised
 * support — empirically verified byte-perfect end-to-end against a passive
 * sink on tmux 3.6 (pre-build research §1). Body line terminators normalize
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
 */
export async function pasteText(exec: TmuxExec, target: string, text: string): Promise<void> {
  await ensureLive(exec, target);

  // Normalize line terminators: \r\n → \n, lone \r → \n. Inside the
  // bracketed paste, every line break is a literal newline in the input box,
  // never a submit. Submit is `Enter` outside the brackets.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Per-call buffer name so concurrent pastes can't collide.
  const bufferName = `claudemux-${randomBytes(4).toString("hex")}`;

  // load-buffer reads the body from stdin via the `-` argument.
  {
    const args = ["load-buffer", "-b", bufferName, "-"];
    const r = await exec.run(args, { sessionName: target, input: normalized });
    const err = classifyTmuxFailure(target, ["tmux", ...args], r);
    if (err) throw err;
  }

  // paste-buffer -p emits bracketed sequences when the receiver supports them.
  // -d deletes the buffer after pasting (so we don't litter tmux's buffer list).
  {
    const args = ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", target];
    const r = await exec.run(args, { sessionName: target });
    const err = classifyTmuxFailure(target, ["tmux", ...args], r);
    if (err) throw err;
  }
}

/**
 * Send a named key to the session. Used for both REPL submission (`Enter`
 * after a paste) and dialog responses (`1`, `2`, `y`, `n`, `Escape`).
 *
 * Pre-checks liveness like {@link pasteText}.
 */
export async function sendKey(
  exec: TmuxExec,
  target: string,
  key: "Enter" | "Escape" | "1" | "2" | "y" | "n",
): Promise<void> {
  await ensureLive(exec, target);
  const args = ["send-keys", "-t", target, key];
  const r = await exec.run(args, { sessionName: target });
  const err = classifyTmuxFailure(target, ["tmux", ...args], r);
  if (err) throw err;
}

async function ensureLive(exec: TmuxExec, target: string): Promise<void> {
  if (!(await hasSession(exec, target))) {
    throw new SessionGone(target);
  }
}
