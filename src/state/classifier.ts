import type { State } from "../types.js";
import type { ClassifierRules } from "./types.js";

/**
 * Map pane text → {@link State} via the agent's rules.
 *
 * **The dispatch order is load-bearing** and enforced by the function's
 * structure, not by reviewer vigilance:
 *
 *   `dialog → permission-prompt → working → idle → unknown`
 *
 * Dialog is checked before everything else so a boot dialog with a stray
 * idle-shaped substring cannot mis-classify as idle. Permission-prompt is
 * checked before working/idle so a permission shape mid-stream cannot
 * mis-classify as working. `unknown` is the contractual "no predicate
 * fired" return — consumers must not treat it as idle.
 *
 * @param text - The pane text to classify. Callers must pre-slice to the
 *   bottom-N lines (the "scrollback trap" — see
 *   `engineer/wiki/tmux-capture-pane-the-bottom-n-trap`).
 * @param rules - The agent's predicate set.
 *
 * @example
 * ```ts
 * import { classify } from "./classifier.js";
 * const state = classify(bottomLines, claude.rules);
 * ```
 */
export function classify(text: string, rules: ClassifierRules): State {
  if (rules.dialog(text)) return "dialog";
  if (rules.permissionPrompt(text)) return "permission-prompt";
  if (rules.working(text)) return "working";
  if (rules.idle(text)) return "idle";
  return "unknown";
}
