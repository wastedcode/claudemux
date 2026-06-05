import { type TmuxExec, classifyTmuxFailure } from "./exec.js";

/**
 * Argv chunks that set the substrate's four server-global tmux options.
 * Joined into a multi-command invocation in front of `new-session` so the
 * globals are set **in the same tmux client connection** that creates the
 * session — see `engineer/wiki/tmux-private-server-bootstrap`.
 *
 * Why this shape: `start-server` does not keep the server alive on its own
 * (tmux exits the server when no session remains). `set-option -g` against
 * an empty server fails with "no server running." Combining all commands
 * into one `tmux …` invocation with `;` separators avoids the dead-window
 * between "server starts" and "first session lands."
 *
 * `history-limit` is allocated at pane creation, so it must be set as a
 * `-g` window-option BEFORE the pane is created. The other three follow the
 * same pattern for consistency.
 *
 * `LC_ALL=C.UTF-8` lives on the session env (`-e` on new-session), so it is
 * not in this list.
 */
const SERVER_OPTION_COMMANDS: ReadonlyArray<readonly string[]> = [
  ["set-option", "-g", "escape-time", "0"],
  ["set-option", "-g", "default-terminal", "tmux-256color"],
  ["set-window-option", "-g", "history-limit", "50000"],
  ["set-window-option", "-g", "remain-on-exit", "off"],
];

/**
 * Build the argv prefix that sets all server-globals, ready to be `;`-joined
 * with a `new-session` (or any other command) into one tmux invocation.
 *
 * Returns chunks separated by `;` markers — callers concat with the next
 * command's argv.
 */
export function serverOptionsArgv(): string[] {
  const out: string[] = [];
  for (const cmd of SERVER_OPTION_COMMANDS) {
    out.push(...cmd, ";");
  }
  return out;
}

/**
 * Map a backend-neutral session-meta key to a tmux **session user option**.
 * User option names must begin with `@`; we further namespace under
 * `@claudemux-` so the substrate's keys never collide with a consumer's own
 * tmux options on the shared server.
 */
function userOptionName(key: string): string {
  return `@claudemux-${key}`;
}

/**
 * Persist a session-scoped key/value as a tmux user option on `target`. The
 * value is passed as a single argv element (no shell), so no escaping is
 * needed. The option lives with the session and is dropped when the session
 * is killed — no cleanup required.
 */
export async function setSessionOption(
  exec: TmuxExec,
  target: string,
  key: string,
  value: string,
  label: string = target,
): Promise<void> {
  const args = ["set-option", "-t", target, userOptionName(key), value];
  const r = await exec.run(args, { sessionName: label });
  const err = classifyTmuxFailure(label, ["tmux", ...args], r);
  if (err) throw err;
}

/**
 * Read a session user option previously set via {@link setSessionOption}.
 * Returns `undefined` when the option is unset or the session/server is
 * unreadable — this is best-effort metadata, never a hard error. `-v` prints
 * just the value; an unset user option yields empty output (trimmed → unset).
 */
export async function getSessionOption(
  exec: TmuxExec,
  target: string,
  key: string,
  label: string = target,
): Promise<string | undefined> {
  let r: Awaited<ReturnType<TmuxExec["run"]>>;
  try {
    r = await exec.run(["show-options", "-t", target, "-v", userOptionName(key)], {
      sessionName: label,
    });
  } catch {
    return undefined; // session gone / no server / wedged — treat as "unset"
  }
  if (r.exit !== 0) return undefined;
  const v = r.stdout.trim();
  return v.length > 0 ? v : undefined;
}
