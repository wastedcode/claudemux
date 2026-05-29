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
   * Deliver `text` as one logical user turn. Multi-line input is paste-safe
   * by construction (the substrate has no `sendRawText` primitive).
   *
   * Blocks on **write delivery**, NOT on the agent's response.
   */
  send(text: string): Promise<void>;

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
