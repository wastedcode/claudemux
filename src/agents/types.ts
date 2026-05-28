import type { ClassifierRules } from "../state/types.js";

/**
 * A single boot dialog: how to recognize it and how to respond.
 *
 * @remarks
 * Used by `src/session/boot.ts`'s dialog loop. Dialogs are tried in order
 * for each pane snapshot — the first matcher wins. `respond.kind === "throw"`
 * is the escape hatch for dialogs that mean "this is a setup error, not an
 * auto-answerable prompt" (e.g. `login-method` under claudemux, which means
 * the user is not authenticated — see `LoginRequired`).
 */
export interface BootDialog {
  /** Stable identifier; used in `DialogStuck.dialogId`. */
  id: string;
  /** Returns `true` when the pane text indicates this dialog. */
  matches(paneText: string): boolean;
  /**
   * What to send to dismiss the dialog. `key` sends a single keystroke and
   * advances; `throw` raises a typed error keyed by `errorClass`.
   */
  respond:
    | { kind: "key"; key: "Enter" | "1" | "2" | "y" | "n" }
    | { kind: "throw"; errorClass: "LoginRequired" };
  /**
   * Optional authority gate. A gated dialog represents an authority grant
   * (e.g. trusting a folder) that the substrate must NOT auto-answer by
   * default — it fails closed. `boot.ts` throws the gate's error *before*
   * sending the response key unless the consumer explicitly opted in via the
   * matching `CreateOptions` flag. Dismissing it otherwise would make a
   * silent policy decision for the caller (north-star: "report state, the
   * consumer decides policy").
   */
  gate?: {
    /** The `CreateOptions` boolean that must be `true` to auto-answer. */
    option: "trustWorkspace";
    /** The error thrown when the gate is closed (not opted in). */
    errorClass: "WorkspaceUntrusted";
  };
}

/**
 * Everything the substrate needs to know about a specific agent. Adding
 * `codex` later = add `src/agents/codex.ts` and export an `AgentDef`.
 *
 * The substrate never imports from `src/backends/**` here. Layering is
 * grep-enforced.
 */
export interface AgentDef {
  /** Stable identifier (e.g. `"claude"`). */
  readonly name: string;

  /** Resolve the spawn argv for this agent given a cwd. */
  buildArgv(o: { cwd: string; extraArgs?: string[] }): {
    cmd: string;
    argv: string[];
    env?: Record<string, string>;
  };

  /** Boot orchestration knobs. */
  readonly boot: {
    /** Ordered list of dialogs to try on each snapshot during boot. */
    readonly dialogs: ReadonlyArray<BootDialog>;
    /**
     * Returns `true` when the bottom-N pane text indicates the REPL is
     * ready for input. Must qualify by line context — see
     * `engineer/wiki/tmux-capture-pane-the-bottom-n-trap` ("same glyph,
     * different roles").
     */
    isReady(paneTextBottomN: string): boolean;
  };

  /** Classifier predicates for this agent. */
  readonly rules: ClassifierRules;
}
