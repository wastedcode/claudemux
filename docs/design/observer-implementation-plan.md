# Implementation plan: the Observer seam + the turn contract

**Status:** DRAFT — for review. Pairs with [`read-write-split.md`](./read-write-split.md)
(the *why*); this is the *what/how*. Branch: `feat/read-write-split`.
**Compat:** none owed (v0.1.x, no users). Optimize for the right surface.

## 1. Overall design — four seams, one owner each

```
consumer ── policy (patience, what to send, how to answer) ───────────────┐
   │                                                                       │
   ▼  SessionHandle (the standardized public surface)                      │
┌──────────────────────────────────────────────────────────────────────┐ │
│ claudemux core — owns the TURN LIFECYCLE + session identity            │ │
│   send→Cursor · wait→TurnOutcome · turn id · messagesSince · progress  │ │
└───────────────┬───────────────────────────────┬──────────────────────┘ │
                │                                 │                         
        ┌───────▼────────┐               ┌────────▼─────────┐               
        │ Backend (drive)│               │ Observer (truth) │ ◄── policy-free
        │ tmux: spawn/   │               │ FUSES pane +     │               
        │ send/interrupt/│               │ transcript (+hook│               
        │ kill, liveness │               │ marker) → state, │               
        └───────┬────────┘               │ progress, msgs   │               
                │                         └────────┬─────────┘               
                ▼                                  ▼                         
            tmux server                    AgentDef (claude knowledge)       
                                           pane predicates + transcript      
                                           schema + slug — ONE file, rots    
                                           per claude release                
```

**Ownership law (founder: "exactly one place owns/does each thing"):**

| Concern | Sole owner |
|---|---|
| turn lifecycle, turn id, outcome resolution | claudemux core (`src/session/turn.ts`, new) |
| session identity ↔ transcript path | `AgentDef.transcript.locate()` — **one** function |
| drive ops + raw liveness | `Backend` |
| fuse signals → state/progress/messages | `Observer` (agent-agnostic) |
| claude-version-fragile knowledge (pane glyphs, dialogs, transcript schema) | `src/agents/claude.ts` only |
| patience / reaping / retry | the consumer — never claudemux |

The Observer **absorbs** today's split-brain: `io/wait.ts` arming + `io/baseline.ts`
fingerprinting are a *second* state computation beside `state/classifier.ts`. They move
INTO the Observer so state/progress is computed in exactly one place.

## 2. Standardized type surface (the public contract)

Conventions (match existing code): `readonly` fields; discriminated unions on `kind`;
neutral vocabulary (no `tmux`/`jsonl`/`claude` in public types — grep-enforced); every
error extends `ClaudemuxError`; optional fields use `?` not `| undefined` in public docs.

**Observation reliability ordering (founder principle — load-bearing):**
**HOOKS (deterministic, harness-fired) + TRANSCRIPT (structured) are PRIMARY and are what
the trust claim rests on. tmux/pane is a FALLBACK ONLY** — used when the hook channel is
unhealthy, or for the irreducible pre-transcript boot dialogs — and is **explicitly marked
unreliable**. claudemux never observes by scraping a TUI as its guaranteed path; `capture()`
is diagnostic. With hooks off, observation is best-effort/degraded and *says so*
(`hookChannelHealthy: false`). This converges with §7 C4: the one tmux-observe signal
(pane-hash / `Mulling` counter) is also the dishonest one — it animates on wall-clock when
the model is wedged — so it is NOT load-bearing.

```ts
// --- identity & content (neutral; never claude's JSONL union) ---
type Cursor = string;   // opaque + SERIALIZABLE; encodes {transcriptPath, generationToken, anchorNonce}.
                        // own-user-record anchor + transcript-generation token → survives reboot AND
                        // detects compaction. NEVER a bare count/offset (§7 C1/C2).
interface Message {
  readonly id: string;                 // STABLE — addressable for stream dedup / update-in-place
  readonly role: "user" | "assistant";
  readonly parts: MessagePart[];
  readonly at?: string;
}
type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly tool: string; readonly summary: string }
  | { readonly kind: "tool-result"; readonly ok: boolean; readonly summary: string };

type State = "working" | "idle" | "permission-prompt" | "dialog" | "unknown";  // precedence modal>working>idle, fixtured

// --- progress: RELIABLE signals only (hook edges + transcript); no load-bearing pane ---
interface Progress {
  readonly phase: "prompt" | "tool" | "composing" | "done" | "unknown";  // from HOOK edges
  readonly toolInFlight: boolean;        // PreToolUse seen, PostToolUse not → legitimately running, not hung
  readonly transcriptCount: number;      // completed blocks
  readonly hookChannelHealthy: boolean;  // false → observation degraded to the pane fallback; trust accordingly
  readonly state: State;
  // NO load-bearing pane-hash (lies on the wall-clock spinner, §7 C4; and it's tmux-observe).
  // A timer-stripped paneContentHash exists ONLY as a marked-unreliable heartbeat when
  // hookChannelHealthy === false.
}

// --- turn outcome: stable kind + OPEN reason; `awaiting` = SUSPENSION (resume via send), not terminal ---
type TurnOutcome =
  | { readonly kind: "completed"; readonly messages: Message[] }
  | { readonly kind: "awaiting"; readonly on: AwaitKind; readonly messages: Message[] }
  | { readonly kind: "aborted"; readonly reason: AbortReason }
  | { readonly kind: "budget-exceeded"; readonly phase: Progress["phase"]; readonly toolInFlight: boolean; readonly messages: Message[] }
  | { readonly kind: "degraded"; readonly reason: string };   // usage-exhausted / rate-limited / error
type AwaitKind = "permission" | "question" | (string & {});
type AbortReason = "pane-dead" | "interrupted" | (string & {});

// === the STREAM is the primary observe seam (emit-first) ===
type TurnEvent =
  | { kind: "message"; message: Message }                                    // a completed block
  | { kind: "message-delta"; id: string; part: MessagePart; final: boolean } // block-granular today; token-ready
  | { kind: "progress"; progress: Progress }
  | { kind: "outcome"; outcome: TurnOutcome };

interface SessionHandle {
  readonly agentSessionId?: string;
  // WRITE
  send(text: string): Promise<Cursor>;         // resolves on CONFIRMED delivery (UserPromptSubmit hook);
                                               // throws DeliveryUnconfirmed; throws SessionBusy if a turn is live
  interruptAndReplace(text: string): Promise<Cursor>;   // first-class; the ESC-ladder lives in agents/claude.ts
  interrupt(): Promise<void>;                  // sets interrupt-pending → next outcome is aborted:"interrupted" by construction
  kill(): Promise<void>;
  // OBSERVE — the stream is primary; everything else DERIVES from one fused Observer
  subscribe(from: Cursor, on: (e: TurnEvent) => void): () => void;
  wait(opts: { maxMs: number; idleMs?: number }): Promise<TurnOutcome>;   // maxMs MANDATORY → never hangs
  state(): Promise<State>;
  progress(): Promise<Progress>;
  messagesSince(from: Cursor): Promise<Message[]>;   // throws CursorInvalidated on compaction — NEVER []
  messages(opts?: { last?: number }): Promise<Message[]>;   // history for reconnect scrollback
  reachableOutcomes(): readonly TurnOutcome["kind"][];
  capture(opts?: { ansi?: boolean; lines?: number }): Promise<string>;   // RAW pane — diagnostic ONLY, never the observe path
  onBackendCommand(h: (e: BackendCommandEvent) => void): () => void;
}
```

**Why this shape:** the **stream is the single observe seam** — `wait`/`state`/`progress`/
`messagesSince` all derive from one fused Observer (no second computation). The reliability the
trust pitch rests on comes from **hooks + transcript**, claude's own contract, *not* pixel-
scraping. `wait()` requires `maxMs` (never hangs). `awaiting` is a suspension resumed by `send()`.
New typed errors (all `extends ClaudemuxError`): `DeliveryUnconfirmed`, `CursorInvalidated`,
`SessionBusy`.

## 3. Standardized CLI surface (1:1 with the library, machine-readable, backend-neutral)

Existing verbs kept: `spawn send interrupt wait state capture kill list exists`. Changes/adds —
all structured outputs are JSON on stdout so the CLI is scriptable:

| verb | change | output |
|---|---|---|
| `send <name> <text>` | now prints the cursor | `{"cursor":"…"}` |
| `wait <name> [--idle-ms --max-ms]` | returns the TurnOutcome | `{"kind":"completed","messages":[…]}` |
| `messages <name> --since <cursor>` | **new** | `[{role,parts,at}…]` |
| `progress <name>` | **new** | `{transcriptCount,…,phase}` |
| `state <name>` | fused now | `working\|idle\|…` |
| `adopt <name> [--session-id <id>]` | **new** (mirror of create) | exits 0 / `SessionGone` |
| `hooks-config` | **new** — prints exactly what we inject | the settings fragment |

CLI ↔ lib parity is a test (exists today); `--help` stays backend-neutral (grep-guarded).

## 4. Hook injection (on by default, transparent, opt-out)

- On `create()`/`spawn`, claudemux injects via `--settings` a fragment wiring
  `UserPromptSubmit · PreToolUse · PostToolUse · Stop · SessionStart` to append a record to a
  **claudemux-owned local rendezvous** keyed by session id (`$XDG_STATE_HOME/claudemux/turns/<id>.ndjson`,
  fallback temp). No network — local marker only (honors the no-network posture).
- **Transparent:** `hookSpec()` (lib) / `claudemux hooks-config` (CLI) return the exact JSON.
- **Opt-out:** `create({ hooks: false })` → no injection; observation **degrades to the pane
  fallback and SAYS SO** (`hookChannelHealthy: false`) — best-effort, explicitly not the
  guaranteed path. The default (hooks on) is the reliable contract.
- The rendezvous is the **PRIMARY** lifecycle/phase source (the hook edges); the transcript is
  the content source; the pane is the fallback only. This is the inversion of Posse's
  pane-in-the-activity-OR: here hooks lead, the pane never leads.

## 5. Build order (approved; reordered so hooks lead — they're the backbone, not phase 4)

1. **Observer seam, hook+transcript-FIRST, emit-first.** Hook injection on by default +
   rendezvous reader → the lifecycle/phase edges (the reliable source); `AgentDef.transcript.*`
   (locate/parseLine/isTurnBoundary — the ONE slug fn) → content+blocks; fuse into the emitted
   stream with `state()`/`progress()` DERIVED. Pane is fallback only, isolated in
   `agents/claude.ts`, marked via `hookChannelHealthy`. Absorb `io/wait.ts`+`io/baseline.ts`
   (single-owner). New grep guard: transcript/jsonl/`~/.claude` outside `src/agents/**`.
2. **Content on the stream.** `Message` (stable `id`) + nonce-anchored `Cursor` (gen-token) +
   `messagesSince`/`messages` + `message`/`message-delta` events; `CursorInvalidated` on compaction.
   (The deletion of a consumer's hand-rolled transcript parser + dedup.)
3. **Turn control + outcome.** `TurnOutcome` (terminal vs `awaiting`-suspension); `wait({maxMs})`
   (mandatory budget, no hang); `send()→Cursor` + `DeliveryUnconfirmed` + `SessionBusy`;
   `interruptAndReplace()`; `reachableOutcomes()`. Kill the 300s default patience.
4. **Hardening + residual-shrink.** Hook-channel self-test/health, `--settings` deep-merge,
   rendezvous nonce-keying + rotate + file lock (`SessionBusy`); the §9 follow-up spike
   (permission/`Notification` hooks; hook-only boot via pre-trust + `SessionStart`); fixtures +
   the drift canary.

Each phase ships green through the full gate + an ADR + CHANGELOG entry.

## 6. The software quality bar (this makes or breaks it)

Non-negotiable, extends claudemux's existing discipline:

- **Single source of truth, enforced.** Each concern has exactly one owner (§1). The
  Observer-absorbs-arming consolidation is a precondition, not a follow-up — no shipping a
  second state computation.
- **Typed errors only.** Every failure is a `ClaudemuxError` subclass with an actionable,
  backend-neutral message. New: outcomes carry reasons; abnormal states are typed outcomes,
  **never hangs**.
- **Layering, grep-enforced.** Observer is agent-agnostic. ALL claude-version-fragile
  knowledge (pane glyphs, dialog phrases, transcript schema, slug rule) lives in
  `src/agents/claude.ts`. New guard bans `jsonl`/`message.content`/`~/.claude` runtime strings
  outside `src/agents/**`; `no-tmux-in-public` extends to ban `jsonl`/`transcript` in public types.
- **Neutral public surface.** `Message`/`Progress`/`TurnOutcome` carry no claude/tmux/jsonl
  vocabulary. A future backend or a contractual source drops in without consumer changes.
- **Fixture-pinned against claude drift.** Every fragile reader (idle predicate, dialog matcher,
  transcript line parser, hook payload shape) has pure unit fixtures capturing REAL renderings
  from ≥1 platform — incl. the known variants (bare `❯ ` vs `❯ Try…` ghost text; signal-name vs
  number). Bugs caught by a fixture, not a user's hang.
- **Drift canary.** Extend `glyph-canary.yml` → run the matchers + hook wiring against freshly
  installed latest claude on a schedule; open an issue on any miss. Publish a supported-claude
  version matrix.
- **Test tiers.** (a) pure unit on parsers/classifiers (no spawn); (b) integration on an
  isolated tmux socket; (c) on-box post-auth dogfood (ADR 0005 — CI never authenticates).
  The four CI guards stay green; add the new layering guard.
- **Mechanism, not policy.** Zero library-owned idle timeouts/reaping. Patience is a
  consumer-supplied parameter or the consumer's `progress()` loop.
- **Observability.** `onBackendCommand` extends to read-side ops (transcript reads, rendezvous
  reads) so a consumer can debug a wrong state the same way they debug a wrong send.
- **Docs discipline.** ADRs for: the Observer seam, the hook-injection-by-default decision, the
  TurnOutcome model. CHANGELOG per phase. README updated when the surface changes.
- **Concurrency.** The per-session mutex covers observe ops too; no interleaving.

## 7. Adversarial pass — findings → design changes

A red-team broke the contracts and a NON-Posse builder (interactive streaming chat client)
used the interface. Both surfaced real holes. The three §7-open questions are now answered by
the findings, and one new architectural decision emerged.

**Critical (fix before building):**
- **C1. Cursor must be nonce-anchored, not count/offset.** A count cursor can't attribute
  blocks to the right `send()` (two rapid sends bracket the same output) and **claude
  compaction rewrites the `.jsonl` mid-session** → a count/offset cursor silently returns `[]`
  or garbage. FIX: `send()` injects a per-turn **nonce** + positively identifies its own
  user-record; `Cursor = {transcriptPath, transcriptGenerationToken, anchorNonce}`;
  `messagesSince` throws typed **`CursorInvalidated`** when the anchor is no longer resolvable
  (compaction) — **never** returns `[]`. This resolves §7-Q1 (cursor encoding).
- **C2. "Never hangs" vs "`wait()` no-opts waits forever" are contradictory.** FIX: **`maxMs`
  is mandatory** (resolves §7-Q3). Zero-arg `wait()` is removed; a true hang resolves
  `budget-exceeded` at the consumer's ceiling.
- **C3. Per-turn id: YES** (resolves §7-Q2). The nonce IS the turn id — doubles as cross-process
  "is my pre-reboot turn still live" and the rendezvous key (see C7).
- **C4. The activity-OR LIES on a time-driven spinner.** `✻ Mulling (1m 6s)` animates on
  wall-clock even when wedged → `paneHash` flips → `state()==="working"` forever. The
  "thinking-vs-hung SOLVED" claim was WRONG for the wedged case. FIX: hash a **timer-stripped**
  pane region (`paneContentHash`, not raw); the strip rule lives in `src/agents/claude.ts`.

**High:**
- C5. `awaiting` is a **suspension, not terminal** — one `send()` may pass `awaiting`→`completed`.
  Re-spec: *each `wait()` resolves to one outcome; a turn may need multiple `wait()`s*; split
  terminal (`completed`/`aborted`/`degraded`) from suspension (`awaiting`). Define `State`
  precedence (modal > working > idle), fixture it (the flat enum can't express modal+working).
- C6. `budget-exceeded` while a tool is mid-flight → session unsafe to `send()` next, no signal.
  FIX: carry `phase`/`toolInFlight`; contract states **must `interrupt()` (or confirm left
  `working`) before the next `send()`**.
- C7. `send()`-resolves-on-delivery can anchor a turn that never started (lost-Enter). FIX:
  `send()` throws **`DeliveryUnconfirmed`** if not positively confirmed; the `armed`/transition
  fail-safe in `io/wait.ts`+`io/baseline.ts` becomes a **named Observer contract + fixture**,
  not incidental code lost in the consolidation.
- C8. `reachableOutcomes()` only *documents* the AskUserQuestion-disabled deadlock, doesn't
  *prevent* it. Stop overselling: the contract states **a `completed` turn may be semantically
  awaiting; the consumer MUST inspect content** (or claudemux auto-enables AskUserQuestion).
- C9. `interrupt()` sets an in-process **interrupt-pending flag** the Observer reads with
  priority (caller-flag > pane-phrase > content), so `aborted:"interrupted"` can't race to
  `completed`. Fixture the (version-fragile) interrupt phrase.

**Hook/rendezvous hardening:**
- C10. `--settings` **deep-merges** (append to each `hooks.<Event>` array, never replace);
  spawn **self-tests** the hook channel (SessionStart marker landed?) → `hookChannelHealthy`
  reflected in `progress()` + warned via `onBackendCommand`; `hooks-config` shows the *merged*
  result. Silent degradation is the Posse-bug-chasing we're avoiding.
- C11. Rendezvous keyed by **nonce** (not just session-id); `send()` rotates/truncates so a
  stale tail can't satisfy a new `wait()`; **file lock → `SessionBusy`** if a 2nd claudemux
  process drives the same id.
- C12. Single-owner is in-process only today (per-handle mutex). State the boundary: mutex =
  one handle; cross-process exclusivity = the file lock. The fused verdict lives in **ONE
  function all paths call** (in-proc, CLI, post-reboot adopt), verified by a test that CLI
  `state`/`wait` ≡ in-proc from the same fixture.

## 8. NEW decision — the push/subscribe seam (batch-only, or stream too?)

The non-Posse builder's verdict: the entire surface (`state`/`progress`/`messagesSince`/`wait`)
is **poll-or-resolve — no push anywhere**. A streaming/interactive consumer is forced to poll
`messagesSince` every ~150ms to fake streaming (re-reading the transcript, synthesizing message
ids, dedup, reconciling against `wait()`'s payload) — the exact anti-pattern this design deletes
for batch consumers. The internal fused Observer is *already* event-shaped (the spike's hook
edges: UserPromptSubmit / Pre/PostToolUse / Stop). Proposed:

```ts
subscribe(cursor: Cursor, h: (e: TurnEvent) => void): () => void;
type TurnEvent =
  | { kind: "message"; id: string; message: Message }        // a completed block
  | { kind: "message-delta"; id: string; part: MessagePart; final: boolean } // future token-stream
  | { kind: "progress"; progress: Progress }
  | { kind: "outcome"; outcome: TurnOutcome };
```
`wait()`/`state()`/`messagesSince()` become thin conveniences over the stream. Also from the
builder: **`Message` needs a stable `id`** (poll dedup/flicker); a **defined `send()`-while-
`working` contract** (`SessionBusy` vs documented paste) + a "ready for input" signal; a
**history read** (`messages({last})`) for reconnect scrollback; and a **first-class
`interruptAndReplace()`** so the ESC-ladder pane-scrape lives in `agents/claude.ts`, not every
interactive consumer's hot path.

**RESOLVED (founder): emit-first.** The Observer is built to EMIT; `subscribe` is the primary
seam; `wait`/`state`/`progress`/`messagesSince` derive from the stream. `Message.id` and the
`send()`-while-`working` contract (`SessionBusy`) land in the core, not a later phase. Batch is
trivially derivable from a stream; the reverse is the expensive retrofit.

## 9. Observation must not rely on tmux (founder principle) — and the honest residual

The trust claim ("guaranteed/reliable insight into the session") rests on **hooks + transcript**,
never on scraping the TUI. Concretely:
- **Lifecycle/phase** (`prompt → tool → composing → done`, `toolInFlight`) comes from **hook
  edges** (`UserPromptSubmit`/`Pre`/`PostToolUse`/`Stop`), proven reliable in the spike — not the pane.
- **Content** comes from the **transcript**, not `capture()`.
- **Our own `interrupt()`** is known from an in-process flag (we did it), not pane-scraping.
- **`capture()` / pane-hash** are diagnostic + a *marked-unreliable* fallback only, surfaced via
  `hookChannelHealthy: false`.

**Honest residual (can't reach literal zero-tmux-observe today):**
1. **Pre-transcript boot dialogs** (workspace-trust, login) fire before any hook/transcript and
   are pane-modal. **Shrink plan:** pre-configure workspace trust + treat the **`SessionStart`
   hook** as the ready signal (spike confirmed it fires once the session starts), so boot
   readiness stops depending on scraping `❯`. Any dialog still needing a keystroke is the
   irreducible minimum, isolated in `agents/claude.ts`, fixtured.
2. **Externally-induced interrupt** (a founder hits ESC in an attached tmux) has no hook and no
   our-flag → pane-phrase fallback only. Marked unreliable.

**Follow-up spike (owed, to drive the residual down):** does a permission prompt / other blocked
state fire a `Notification`/`PermissionRequest` hook (so `awaiting:"permission"` is hook-derived,
not pane)? Can boot be made hook-only via pre-trust + `SessionStart`? These determine how close to
zero-tmux-observe we get. Until measured, the contract states plainly which signals are
hook-backed (reliable) vs pane-fallback (best-effort).
