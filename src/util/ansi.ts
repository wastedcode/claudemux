/**
 * Tiny terminal-hygiene helpers. Generic (no agent vocabulary) — safe to use
 * from agent-agnostic layers.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are the point.
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Strip SGR (color/style) escape sequences — `ESC [ … m` — from a string.
 *
 * Used by predicates that match *plain* pane substrings (dialog headers,
 * `esc to interrupt`) so they keep working when the pane is captured with
 * ANSI styling on (`capture -e`). The styling itself is only meaningful to the
 * readiness check, which interprets it directly rather than stripping it.
 */
export function stripSgr(s: string): string {
  return s.replace(SGR, "");
}
