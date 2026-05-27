/**
 * Predicates the classifier dispatches over. Each agent (`src/agents/*.ts`)
 * supplies its own rules; the classifier itself is agent-agnostic.
 */
export interface ClassifierRules {
  /** True when the pane is showing a boot/system dialog. */
  dialog(text: string): boolean;
  /** True when the pane is showing a permission prompt awaiting user input. */
  permissionPrompt(text: string): boolean;
  /** True when the agent is actively producing output (spinner, streaming). */
  working(text: string): boolean;
  /** True when the REPL is idle and ready for input. */
  idle(text: string): boolean;
}
