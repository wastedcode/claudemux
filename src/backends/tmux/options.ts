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
export const SERVER_OPTION_COMMANDS: ReadonlyArray<readonly string[]> = [
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
