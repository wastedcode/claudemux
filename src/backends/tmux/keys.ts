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
/**
 * Strip control bytes from a paste body that could break out of the bracketed
 * paste or inject terminal control. The danger (F48): a body containing the
 * paste-END marker `ESC[201~` closes the bracket early, so its tail submits as
 * *typed* input — content carrying terminal escapes (logs, diffs, adversarial
 * input) could run commands. Keep `\n` (literal newlines — the point of bracketed
 * paste) and `\t`; drop the bracketed-paste markers explicitly (no `[201~`
 * residue) plus every other C0/DEL control byte (incl. bare ESC). Normalize CRs
 * to `\n` BEFORE stripping so a lone `\r` becomes a newline, not nothing.
 */
export function sanitizePasteBody(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
      .replace(/\x1b\[20[01]~/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}

export async function pasteText(
  exec: TmuxExec,
  target: string,
  text: string,
  label: string = target,
): Promise<void> {
  await ensureLive(exec, target, label);

  const normalized = sanitizePasteBody(text);
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
