import type { ClassifierRules } from "../state/types.js";
import type { Message } from "../types.js";

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
    /**
     * Neutral "resume this existing conversation" request from the session
     * layer's `resume()`. The agent maps it to its own resume flag (claude:
     * `--resume <id>`) and surfaces that id as `agentSessionId`. Mutually
     * exclusive with `sessionId`/an `extraArgs` identity flag (choosing the id
     * twice → typed conflict). Keeps the vendor flag inside the agent seam.
     */
    resumeFrom?: string;
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

  /**
   * Reading the agent's session transcript. The **sole owner** of this agent's
   * transcript knowledge — both *where* the file lives and *how* its records
   * parse — so every claude-version-fragile bit stays in one file
   * (grep-enforced). The agent-agnostic Observer reads the file and feeds its
   * lines here; it never knows the schema or the path rule.
   *
   * Optional for now: only the real agent implements it, and the Observer that
   * consumes it has not landed. Becomes required once the Observer depends on it.
   */
  readonly transcript?: {
    /**
     * Absolute path of the on-disk transcript for a session id, or `null` if
     * not found. Located by id across the agent's session store — never by
     * recomputing the fragile cwd→path rule.
     */
    locate(o: { agentSessionId: string; home?: string }): string | null;
    /**
     * Parse one transcript line into a neutral {@link Message}, or `null` for a
     * metadata record, a blank line, or a partial/half-flushed line.
     */
    parseLine(line: string): Message | null;
    /**
     * The raw ancestry link (`id` + optional `parentId`) of **any** transcript
     * record that carries an identity — including non-message records (e.g.
     * `attachment`) that an agent may thread *between* a prompt and its reply.
     * Returns `null` for blank/partial lines and records with no id.
     *
     * Lets the consumer reconstruct the *full* causal graph and so detect
     * message descendants even when the chain passes through records
     * {@link parseLine} drops. Optional: when absent, descendant detection falls
     * back to links between surfaced messages only.
     */
    parseEdge?(line: string): { id: string; parentId?: string } | null;
    /**
     * True when `message` starts a new user turn (a typed prompt), false for
     * tool-result feedback that is also recorded turn-side.
     */
    isTurnStart(message: Message): boolean;
  };

  /**
   * Hook-based turn observation — the SOLE owner of this agent's hook
   * vocabulary (which events to wire, the settings shape, the marker format).
   * The agent emits turn markers to a claudemux-owned local rendezvous; the
   * Observer reads them as deterministic phase edges (no pane-scraping). The
   * spawn layer injects {@link spec}'s flag at launch; the Observer parses each
   * rendezvous line with {@link parseMarker}. Both live here so the
   * hook-event strings stay out of the agent-agnostic layers (grep-enforced).
   *
   * Optional for now — becomes load-bearing when injection + the Observer land.
   */
  readonly hooks?: {
    /**
     * The launch flag that wires this agent's turn hooks to append markers to
     * `rendezvousPath`. Inspectable (transparency) and the one place that knows
     * the settings shape. e.g. `{ flag: "--settings", value: "<json>" }`.
     */
    spec(o: { rendezvousPath: string }): { flag: string; value: string };
    /** Parse one rendezvous marker line into a neutral {@link HookEdge}, or null. */
    parseMarker(line: string): HookEdge | null;
  };
}

/**
 * A neutral, deterministic turn-lifecycle edge derived from an agent hook —
 * the reliable observe signal (vs pane-scraping). `event` is backend-neutral;
 * the Observer composes a sequence of these into phase / toolInFlight / done.
 *
 * Beyond the bare edge, a hook payload also carries data the Observer fuses with
 * the transcript and pane. Those fields are surfaced here as **neutral** concepts
 * (`transcriptPath`, `source`, `finalMessage`); the agent's `parseMarker` owns
 * translating its vendor payload (e.g. claude's `transcript_path` /
 * `last_assistant_message`) into them, so vendor field names never leak past the
 * agent seam (grep-enforced). All are optional — present only on the edges that
 * carry them, and only for agents whose hooks expose them.
 */
export interface HookEdge {
  readonly event:
    | "session-start"
    | "prompt-submit"
    | "tool-start"
    | "tool-end"
    | "stop"
    | "notification"
    | "pre-compact"
    | "other";
  /** Epoch milliseconds the hook fired. */
  readonly at: number;
  /** The agent session id the hook reported, when present. */
  readonly sessionId?: string;
  /** Tool name for `tool-start`/`tool-end` edges, when present. */
  readonly tool?: string;
  /**
   * The **authoritative** absolute path of the session's durable transcript, as
   * the hook reported it. The Observer prefers this over recomputing/globbing
   * the on-disk location (the path rule is fragile). Present on most edges.
   */
  readonly transcriptPath?: string;
  /**
   * Why the session started — only on a `session-start` edge. Lets the Observer
   * distinguish a fresh boot from a resume (expect a history re-print) or a
   * post-compaction continuation, without inspecting the screen.
   */
  readonly source?: "start" | "resume" | "clear" | "compact";
  /**
   * A preview of the turn's terminal assistant text, as the agent reported it on
   * the `stop` edge — available *before* the transcript flushes that record.
   * The Observer uses it to close the hook→transcript flush skew: on `stop` it
   * polls the transcript until the durable reply is present, rather than reading
   * stale content the instant the edge fires.
   */
  readonly finalMessage?: string;
}
