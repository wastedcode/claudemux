import { PaneDead } from "../../errors.js";
import { type TmuxExec, classifyTmuxFailure, detectPaneDeadAnnotation } from "./exec.js";

/**
 * Capture the named session's pane text.
 *
 * Always uses `capture-pane -p` (the live visible region — proven unaffected
 * by copy-mode and attached clients; see
 * `docs/decisions/0003-capture-pane-invocation.md`). Bottom-N
 * slicing happens **in code** via `output.split('\n').slice(-N)`, NEVER
 * `capture-pane -S -N` — the latter returns `N + pane_height` lines, not
 * bottom-N (see `engineer/wiki/tmux-capture-pane-the-bottom-n-trap`).
 *
 * `-e` flag is added only when the caller passes `ansi: true`; the default
 * is plain text (which is what the classifier matches against anyway).
 *
 * If the capture output contains the `Pane is dead (signal N, …)` annotation
 * (Case A, when `remain-on-exit` is `on`), `PaneDead` is thrown.
 */
export async function capturePane(
  exec: TmuxExec,
  target: string,
  opts: { ansi?: boolean; lines?: number; label?: string } = {},
): Promise<string> {
  const label = opts.label ?? target;
  const args = ["capture-pane", "-p"];
  if (opts.ansi === true) args.push("-e");
  args.push("-t", target);

  const r = await exec.run(args, { sessionName: label });
  const err = classifyTmuxFailure(label, ["tmux", ...args], r);
  if (err) throw err;

  // Surface Case A pane-death loudly — Case B (session gone) is already
  // surfaced by classifyTmuxFailure above. The annotation lands in stdout.
  const signal = detectPaneDeadAnnotation(r.stdout);
  if (signal !== null) {
    throw new PaneDead(label, signal);
  }

  if (opts.lines !== undefined && opts.lines > 0) {
    const lines = r.stdout.split("\n");
    return lines.slice(-opts.lines).join("\n");
  }
  return r.stdout;
}
