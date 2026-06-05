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
 * agent has stopped working. Returned by {@link SessionHandle.state}-adjacent
 * helpers; superseded for `wait()` by {@link TurnOutcome}.
 */
export type IdleState = Extract<State, "idle" | "permission-prompt" | "dialog">;

/**
 * The terminal result of {@link SessionHandle.wait} — the single fused verdict
 * for "the turn stopped, and why." `kind` is the stable discriminant; the nested
 * axis (`on` / `reason`) is the open detail.
 *
 * **Compound ownership.** `wait()` is the *one* owner of this decision and it
 * COMPOSES two atomic sub-owners without re-deriving their internals:
 *   - the **observe** sub-owner (the Observer's fused belief from hooks +
 *     transcript + pane) yields `completed` / `awaiting` / `aborted` /
 *     `degraded`;
 *   - the **policy** sub-owner — the **consumer's** patience, passed as
 *     {@link ReadyOpts} — yields `budget-exceeded`: `reason:"idle"` (no progress
 *     for `idleMs`) vs `"max"` (wall-clock `timeoutMs` elapsed). The library owns
 *     **no** patience of its own: with neither budget supplied, `wait()` never
 *     returns `budget-exceeded` — it waits for a terminal belief. "Time is the
 *     policy's."
 *
 * `completed` guarantees the reply is **readable**: the Observer closes the
 * hook→transcript flush skew before reporting it, so a following
 * `messagesSince(cursor)` is race-free. Content never rides on the outcome — it
 * stays with `messagesSince` (the one content owner).
 */
export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "awaiting"; readonly on: "permission-prompt" | "dialog" }
  | { readonly kind: "aborted" }
  | { readonly kind: "budget-exceeded"; readonly reason: "idle" | "max" }
  | { readonly kind: "degraded" };

/**
 * A single conversation message, **backend-neutral** — never the agent's raw
 * on-disk record shape. `parts` is the ordered content of one turn-side.
 */
export interface Message {
  /** Stable per-message id (addressable for streaming dedup / update-in-place). */
  readonly id: string;
  /**
   * Id of this message's parent in the conversation thread, when the agent
   * records one. Lets `messagesSince` follow causal order rather than file
   * order — robust to the transcript flushing records slightly out of sequence.
   */
  readonly parentId?: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly MessagePart[];
  /** ISO timestamp, when the agent records one. */
  readonly at?: string;
}

/**
 * A neutral answer to an agent permission prompt (the tool-approval menu that
 * `wait()` surfaces as `{ kind: "awaiting", on: "permission-prompt" }`). The
 * three choices map to every agent's prompt regardless of its menu wording or
 * option order — the agent owns the translation to a concrete keystroke
 * ({@link SessionHandle.respond}). Backend-neutral by design: a consumer writes
 * `respond("approve")`, never a digit.
 *
 *   - `"approve"` — allow this one action (claude: option 1, "Yes").
 *   - `"approve-for-session"` — allow it and stop asking for the rest of the
 *     session (claude: option 2, "Yes, allow all … during this session"). An
 *     authority grant broader than a single action — the consumer's call.
 *   - `"deny"` — refuse (claude: option 3, "No"); the agent reports back to the
 *     model that the tool was rejected and continues the turn.
 */
export type PromptChoice = "approve" | "approve-for-session" | "deny";

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
  /** Count of parsed transcript messages (a coarse, monotonic progress signal). */
  readonly transcriptCount: number;
  /**
   * Whether the hook channel is delivering. `false` means observe has degraded
   * to the best-effort pane fallback (hooks off, or no markers seen) — trust
   * the reliable fields accordingly.
   */
  readonly hookChannelHealthy: boolean;
  /**
   * **Drift canary.** `false` when EVERY observe channel came up blind against a
   * non-empty pane at once: the pane has real content, yet the classifier read no
   * state (`unknown`), no hook edges arrived, and no transcript messages parsed.
   * That triple-blind is the signature of the agent's output format having
   * **drifted** from what the parsers expect (a Claude Code update moved the idle
   * box / hook payload / record shape). Any single channel producing signal — a
   * recognized state, an edge, a parsed message, a known interrupt — keeps it
   * `true`. A point-in-time snapshot: a consumer treats *persistent* `false` as
   * "my version assumptions broke," not a one-frame blip. Distinct from
   * `hookChannelHealthy` (one channel, often legitimately off) — this fires only
   * when ALL channels are blind together.
   */
  readonly agentChannelHealthy: boolean;
  /** The fused state verdict. */
  readonly state: State;
}

/**
 * The consumer's **patience** for {@link SessionHandle.wait} — the policy
 * sub-owner of {@link TurnOutcome}. The library imposes **no** patience of its
 * own ("time is the policy's"): every field is optional with **no default**, and
 * with none supplied `wait()` blocks until a terminal belief
 * (`completed`/`awaiting`/`aborted`) — it never invents a deadline. Supply a
 * bound to cap a turn that may never end; the matching `budget-exceeded.reason`
 * tells you which bound tripped.
 *
 * @example
 * ```ts
 * await session.wait();                          // no bound — wait for the turn
 * await session.wait({ maxMs: 60_000 });          // give up after 60s wall-clock
 * await session.wait({ idleMs: 30_000 });         // give up after 30s of no progress
 * ```
 */
export interface ReadyOpts {
  /**
   * Wall-clock cap (ms from the call). Exceeded ⇒ `budget-exceeded{reason:"max"}`.
   * No default — omit to wait without a wall-clock bound.
   */
  maxMs?: number;
  /**
   * No-progress cap (ms): give up after this long with no observable progress AND
   * the agent not in a known-working state (no spinner, no tool in flight). A
   * progressing or working turn never trips it (its heartbeat keeps resetting),
   * so this is "stuck too long," never "still working too long." Exceeded ⇒
   * `budget-exceeded{reason:"idle"}`. No default.
   */
  idleMs?: number;
  /**
   * @deprecated Use {@link maxMs} instead. Kept as a source-compatible alias.
   * (Previously defaulted to 300_000ms; that library-owned default is gone —
   * patience is the consumer's.)
   */
  timeoutMs?: number;
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
   * {@link Cursor} anchored at this send (the user record's id) — pass it to
   * {@link messagesSince} to read what the turn produces.
   *
   * When no user record appears, returns one of two detectable sentinels instead
   * of a fragile count (both resolve empty in `messagesSince`/`turnComplete`, so
   * neither floods):
   *   - `DELIVERED_QUEUED` — the session was **busy** and the agent **queued**
   *     the message; it is accepted and will run after the in-flight turn. Do
   *     **not** re-send (that double-runs); `wait()` out the current turn, let the
   *     queued turn run, then read with a fresh cursor.
   *   - `DELIVERY_UNCONFIRMED` — no evidence the message landed (a lost Enter, a
   *     boot-race drop); safe to re-send.
   *
   * An **empty or whitespace-only** `text` is delivered but is a no-op turn —
   * the agent ignores an empty submit, so no user record is written and the
   * return is `DELIVERY_UNCONFIRMED` (there was nothing to anchor). Guard against
   * empty sends in your own code if a no-op turn would confuse your loop.
   */
  send(text: string): Promise<Cursor>;

  /**
   * The messages produced since `cursor` (a value a prior {@link send}
   * returned), as neutral {@link Message}s read from the session transcript.
   *
   * Returns **empty** for two *benign* reasons: there genuinely is nothing new
   * after a resolvable cursor, or the cursor itself can't be resolved (the
   * `DELIVERY_UNCONFIRMED`/`DELIVERED_QUEUED` sentinels, a stale/garbage value —
   * an unresolvable cursor never returns the whole transcript).
   *
   * **Throws `TranscriptUnlocatable`** when the transcript can't be located at all
   * — no recoverable {@link agentSessionId} and no hook-reported path (an
   * {@link adopt} whose cache missed, a non-claudemux session, a fork before its
   * first hook edge). That case is *blind reads*, not "nothing new"; conflating
   * the two silently in a crash-recovery re-send path double-runs work, so it is a
   * loud error rather than a deceptive `[]`. Gate on `agentSessionId !== undefined`
   * (or catch the error) if you adopt sessions that may not be recoverable.
   */
  messagesSince(cursor: Cursor): Promise<Message[]>;

  /**
   * Did the turn anchored at `cursor` produce a reply? `true` iff an assistant
   * message descends from it. The crash-recovery signal: after a resume, a
   * `false` for your last-sent cursor means that turn was **lost** (the prompt
   * is in the transcript with no reply) — re-send it. A *completed* turn is
   * `true`; an in-flight or never-delivered one is `false`. Avoids hand-rolling a
   * transcript scan to answer "what should I re-send?".
   *
   * Like {@link messagesSince}, it **throws `TranscriptUnlocatable`** when the
   * transcript can't be located at all (no recoverable id, no hook path) — so a
   * blind read in the re-send path surfaces loudly instead of a deceptive `false`
   * that would re-send a turn that actually completed. A locatable-but-replyless
   * turn is the honest `false`.
   */
  turnComplete(cursor: Cursor): Promise<boolean>;

  /**
   * A point-in-time {@link Progress} snapshot — turn phase and progress signals
   * fused from the reliable hook + transcript channels (not pane-scraping).
   * Policy-free: the consumer turns staleness into its own patience.
   */
  progress(): Promise<Progress>;

  /**
   * Answer a permission prompt — the tool-approval menu `wait()` reports as
   * `{ kind: "awaiting", on: "permission-prompt" }`. Sends the single keystroke
   * that selects {@link PromptChoice} in this agent's menu (the agent owns the
   * option-order mapping, so the consumer never types a digit). The natural
   * pairing: `wait()` → `awaiting{permission-prompt}` → `respond(choice)` →
   * `wait()` again for the turn to actually finish — `respond` is to the prompt
   * what `send` is to the composer.
   *
   * **Mechanism, not policy** (mirrors {@link interrupt}). It fires the keystroke
   * *unconditionally* — it does not first confirm a prompt is showing. Unlike
   * `interrupt`'s ESC, a stray digit is NOT harmless: sent when no prompt is up
   * it lands in the composer as draft text that the next `send()` would prepend.
   * So gate it on a permission-prompt reading taken in the SAME in-process
   * sequence — and unlike an interrupt race, the prompt is stable (it waits for
   * an answer; it will not resolve underfoot), so a tight `state()`/`wait()` →
   * `respond()` is reliable. Choosing whether/how to approve is the consumer's
   * authority, never the substrate's.
   *
   * Blocks on write delivery only — like `send`, not on what the turn does next.
   * Throws {@link PromptResponseUnsupported} if the agent declares no
   * permission-prompt handling (no menu mapping to translate the choice).
   */
  respond(choice: PromptChoice): Promise<void>;

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
   * **After interrupt(): `state()` reads `unknown` and `wait()` resolves
   * `{ kind: "aborted" }`.** The handle records the interrupt authoritatively (an
   * interrupt fires no `stop` edge and leaves the spinner's "esc to interrupt"
   * frozen in scrollback, so neither channel alone can tell aborted from
   * working). The record clears on the next `send()`. Still do **not** naively
   * `send()` a replacement right after — claude restores the cut text into the
   * composer, so a paste lands onto it and submits the concatenation. Clean
   * "interrupt and replace" clears the composer first — a consumer-composed,
   * claude-specific recipe documented in the README, deliberately not folded
   * into this agent-agnostic verb.
   */
  interrupt(): Promise<void>;

  /**
   * Block until the turn reaches a terminal {@link TurnOutcome} — "it stopped,
   * and here's why." The single owner of the done-decision: it composes the
   * Observer's fused belief (hooks + transcript + pane) with the patience budget,
   * and **never throws on timeout** — a budget overrun returns
   * `{ kind: "budget-exceeded" }`, not an exception.
   *
   * `completed` guarantees the reply is **readable** (the flush skew is closed),
   * so a following `messagesSince(cursor)` is race-free. Content never rides on
   * the outcome — read it with {@link messagesSince}.
   *
   * After {@link interrupt}, this resolves `{ kind: "aborted" }` (the pane shows
   * the interrupted turn; no `stop` hook fires), so it is safe to call.
   */
  wait(opts?: ReadyOpts): Promise<TurnOutcome>;

  /**
   * Return the current fused {@link State} — the Observer's belief
   * (hooks + transcript + pane), not a raw pane scrape; the same owner
   * {@link wait} and {@link progress} defer to. Pure snapshot.
   */
  state(): Promise<State>;

  /**
   * Return the pane text. Default is the live visible region (no ANSI).
   *
   * @param opts.ansi — preserve escape sequences when `true`.
   * @param opts.lines — return only the bottom-N lines.
   */
  capture(opts?: { ansi?: boolean; lines?: number }): Promise<string>;

  /**
   * Kill exactly this session. Idempotent (killing a gone session is success).
   *
   * **A hard stop, not a drain.** If a turn is in flight, its mid-stream reply is
   * lost — the transcript keeps a dangling prompt (the same shape a crash leaves).
   * To stop a turn but *keep* what it produced, `interrupt()` (or `wait()`) and
   * read with `messagesSince` first, then `kill()`.
   */
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
