/**
 * Public types for the claudemux substrate. Re-exported from {@link ./index}.
 *
 * The library is backend-neutral by design: nothing in this file mentions
 * any concrete backend. The internal `Backend` seam lives in
 * `src/backends/types.ts` and is **not** part of the public surface.
 */

/**
 * Coarse-grained pane states the classifier dispatches into.
 *
 * Dispatch order is locked in `src/state/classifier.ts` —
 * `dialog → permission-prompt → working → idle → unknown`.
 *
 * @remarks
 * `unknown` is a contractual "no predicate fired" return, not a soft idle.
 * Consumers must not treat it as idle; the substrate never warns at runtime
 * (no `console.log` in library code per the code-quality bar).
 */
export type State = "working" | "idle" | "permission-prompt" | "dialog" | "unknown";

/**
 * Refinement of {@link State} for callers that only care about whether the
 * agent has stopped working. `wait()` returns one of these.
 */
export type IdleState = Extract<State, "idle" | "permission-prompt" | "dialog">;

/**
 * A single conversation message, **backend-neutral** — never the agent's raw
 * on-disk record shape. `parts` is the ordered content of one turn-side.
 */
export interface Message {
  /** Stable per-message id (addressable for streaming dedup / update-in-place). */
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly MessagePart[];
  /** ISO timestamp, when the agent records one. */
  readonly at?: string;
}

/**
 * An opaque, serializable anchor into a session's message stream, returned by
 * {@link SessionHandle.send}. Pass it to {@link SessionHandle.messagesSince} to
 * read everything produced since that send. Durable across a process restart
 * (the transcript is append-only — manual and auto compaction summarize the
 * context window, never rewrite the on-disk log).
 */
export type Cursor = string;

/** One piece of a {@link Message} — neutral, never a raw tool-call payload. */
export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: string; readonly summary: string }
  | { readonly kind: "tool-result"; readonly ok: boolean; readonly summary: string };

/**
 * A point-in-time snapshot of a session's progress, fused from the reliable
 * observe signals (hook edges + transcript) — **never a verdict the consumer
 * must treat as policy**. The consumer turns staleness of these into its own
 * patience ("progress is the agent's, time is the policy's").
 */
export interface Progress {
  /**
   * Turn phase, from the agent's hook edges (deterministic, not pane-scraped):
   * `prompt` (turn submitted, pre-tool) · `tool` (a tool is in flight) ·
   * `composing` (tool done, model composing) · `done` (turn ended) ·
   * `unknown` (no hook signal — e.g. hooks off, observe degraded).
   */
  readonly phase: "prompt" | "tool" | "composing" | "done" | "unknown";
  /** A tool is legitimately running (a `tool-start` with no matching `tool-end`). */
  readonly toolInFlight: boolean;
  /** Count of completed transcript blocks (a coarse, monotonic progress signal). */
  readonly transcriptCount: number;
  /**
   * Whether the hook channel is delivering. `false` means observe has degraded
   * to the best-effort pane fallback (hooks off, or no markers seen) — trust
   * the reliable fields accordingly.
   */
  readonly hookChannelHealthy: boolean;
  /** The fused state verdict. */
  readonly state: State;
}

/**
 * Options governing {@link SessionHandle.wait}. v0.0.1 ships **state-mode
 * only**; `pattern` and `debounce` modes are deferred to v0.1.
 *
 * @example
 * ```ts
 * await session.wait({ timeoutMs: 60_000 });
 * ```
 */
export interface ReadyOpts {
  /** Hard timeout. Defaults to 300_000ms (5 min). */
  timeoutMs?: number;
}

/**
 * Read-only view of a client attached to the underlying pane. Not exposed
 * in v0.0.1 — the type is reserved for `listClients` in v0.1.
 */
export interface ClientInfo {
  /** Opaque, backend-supplied client identifier. */
  id: string;
  /** Optional TTY path the backend reports for the client. */
  tty?: string;
}

/**
 * The handle returned by {@link create} — the substrate's per-session
 * vocabulary. Every method is mutex-gated so concurrent consumer calls
 * cannot interleave bytes.
 */
export interface SessionHandle {
  /** The session name within the namespace. */
  readonly name: string;
  /** The namespace this session belongs to. */
  readonly namespace: string;

  /**
   * The agent's own conversation id — opaque and **backend-neutral** (today
   * claudemux assigns it as claude's `--session-id`; the field name keeps the
   * API alive across a backend swap). The consumer uses it to resume the exact
   * conversation (`create({ extraArgs: ["--resume", id] })`) and to locate the
   * agent's transcript, without scraping for it.
   *
   * **Optional by truth, never fabricated.** claudemux now *always* mints and
   * injects this id at {@link create} (a deliberate, stable surface — consumers
   * may depend on its presence). But a session created by an older claudemux, a
   * non-claudemux session, an {@link adopt} whose recovery cache missed, or a
   * spawn that rode a bare `--resume`/`--fork-session` in `extraArgs` (where the
   * id is claude's to pick and we cannot know it) reports `undefined` — the
   * honest answer, not a guess. `undefined → string` later stays non-breaking;
   * the reverse would not, which is why it is optional now.
   *
   * @remarks
   * Persist `{ name, agentSessionId }` *together* in your own store for restart
   * recovery: the session-option cache that backs {@link adopt}'s recovery only
   * survives while the backend session is alive; recreating after a crash needs
   * your stored id.
   */
  readonly agentSessionId?: string;

  /**
   * Deliver `text` as one logical user turn. Multi-line input is paste-safe
   * by construction (the substrate has no `sendRawText` primitive).
   *
   * Blocks on **write delivery**, NOT on the agent's response. Returns a
   * {@link Cursor} anchored at this send — pass it to {@link messagesSince} to
   * read what the turn produces.
   */
  send(text: string): Promise<Cursor>;

  /**
   * The messages produced since `cursor` (a value a prior {@link send}
   * returned), as neutral {@link Message}s read from the session transcript.
   * Empty when the transcript can't be located (e.g. an adopted session with no
   * recoverable {@link agentSessionId}).
   */
  messagesSince(cursor: Cursor): Promise<Message[]>;

  /**
   * A point-in-time {@link Progress} snapshot — turn phase and progress signals
   * fused from the reliable hook + transcript channels (not pane-scraping).
   * Policy-free: the consumer turns staleness into its own patience.
   */
  progress(): Promise<Progress>;

  /**
   * Fire `Escape` at the pane — claude's own interrupt key — to stop a
   * working agent.
   *
   * ESC is sent regardless of state; it is meaningful only when
   * `state === working`. ESC on an idle claude is harmless — it clears the
   * input box. The consumer gates on `state()` if they care.
   *
   * Blocks on write delivery plus a brief settle; it guarantees ESC was
   * delivered, NOT that an in-flight abort has fully completed. It does exactly
   * one thing — stop the turn — and bundles no follow-up.
   *
   * **After interrupt(), `state()` reads `unknown`, not `idle`:** claude
   * restores the interrupted message into the composer rather than returning to
   * a clean prompt. So do **not** `wait()`-for-idle after interrupt() (it never
   * settles — no turn is in flight), and do **not** naively `send()` a
   * replacement (it pastes onto the restored text and submits the
   * concatenation). Clean "interrupt and replace" requires clearing the
   * composer first — a consumer-composed, claude-specific recipe documented in
   * the README, deliberately not folded into this agent-agnostic verb.
   */
  interrupt(): Promise<void>;

  /**
   * Block until the classifier reports {@link IdleState}.
   *
   * @throws `ReplTimeout` if `opts.timeoutMs` (default 300_000ms) elapses
   *   before the state settles.
   */
  wait(opts?: ReadyOpts): Promise<IdleState>;

  /** Return the current classifier verdict; pure read. */
  state(): Promise<State>;

  /**
   * Return the pane text. Default is the live visible region (no ANSI).
   *
   * @param opts.ansi — preserve escape sequences when `true`.
   * @param opts.lines — return only the bottom-N lines.
   */
  capture(opts?: { ansi?: boolean; lines?: number }): Promise<string>;

  /** Kill exactly this session. Idempotent. */
  kill(): Promise<void>;

  /**
   * Register an observability hook. Fires for every backend command issued
   * by the substrate, with its argv, duration, exit code, and streams.
   *
   * Returns an unsubscribe function.
   */
  onBackendCommand(handler: (event: BackendCommandEvent) => void): () => void;
}

/**
 * The single observability event surface. Mirrors the internal `BackendEvent`
 * shape with neutral names so consumers do not learn the backend's vocabulary.
 */
export interface BackendCommandEvent {
  /** Unix epoch milliseconds when the command was issued. */
  ts: number;
  /** The argv the substrate spawned. */
  argv: string[];
  /** Wall-clock milliseconds the command took. */
  durationMs: number;
  /** Process exit code. */
  exit: number;
  /** Captured stdout, if any. */
  stdout?: string;
  /** Captured stderr, if any. */
  stderr?: string;
}
