import { type TmuxExec, runForSession } from "./exec.js";

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
 * A gone session surfaces as `SessionGone` via {@link runForSession} (the
 * canonical per-session mapping). The substrate runs `remain-on-exit off`, so a
 * dead pane is reaped rather than left annotated — there is no separate
 * pane-dead path to handle.
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

  // Per-session read: a dead server means THIS session is gone (canonical
  // SessionGone), matching the write path — not a divergent BackendUnreachable.
  const r = await runForSession(exec, args, label);

  if (opts.lines !== undefined && opts.lines > 0) {
    const lines = r.stdout.split("\n");
    return lines.slice(-opts.lines).join("\n");
  }
  return r.stdout;
}
