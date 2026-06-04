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
  /**
   * True when the pane shows a turn that was **interrupted** (ESC) rather than
   * completed — a state only the pane sees (interrupt fires no `stop` hook).
   * Optional: agents that can't distinguish it simply omit it. The Observer
   * maps it to a `TurnOutcome` of `aborted`.
   */
  interrupted?(text: string): boolean;
}
