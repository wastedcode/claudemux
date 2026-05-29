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

  /**
   * Resolve the spawn argv for this agent.
   *
   * @param o.cwd — the working directory (plumbed by the session/backend layer).
   * @param o.extraArgs — caller-supplied flags, passed through verbatim.
   * @param o.sessionId — the substrate-minted (or caller-supplied) conversation
   *   id the agent should run under. The agent decides whether and how to inject
   *   it (claude maps it to `--session-id`); a caller's own identity flag in
   *   `extraArgs` wins over it. Neutral here — the flag *string* is the agent's.
   * @param o.sessionIdExplicit — `true` only when the consumer explicitly chose
   *   the id (`create({ agentSessionId })`), `false`/absent when it was minted.
   *   An explicit id that conflicts with an `extraArgs` identity flag is a
   *   caller error → the agent throws a typed `ClaudemuxError`; a minted id is
   *   silently suppressed by such a flag instead.
   * @param o.sessionName — the session's human label, for typed-error context
   *   on the conflict path (the session has not been spawned yet).
   * @returns `agentSessionId` — the id the argv will **actually** run under (the
   *   injected id, a caller's `extraArgs` id, or `undefined` when the agent
   *   cannot know it, e.g. a bare `--resume`). `create()` surfaces *this* value,
   *   never the mint variable — single source of truth.
   */
  buildArgv(o: {
    cwd: string;
    extraArgs?: string[];
    sessionId?: string;
    sessionIdExplicit?: boolean;
    sessionName?: string;
  }): {
    cmd: string;
    argv: string[];
    env?: Record<string, string>;
    agentSessionId?: string;
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
