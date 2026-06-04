# claudemux — user-flow spec (the consumer-journey contract)

**Purpose.** The standardized contract for *every* flow a consumer drives — happy,
unhappy, and the gnarly recovery paths. The archetypal consumer is **Posse**: a
long-lived daemon that orchestrates many claude sessions (`build` = durable,
`explore` = fresh-only, `consult`/`curation` = one-shot), survives its own
restarts, and must recover sessions that died mid-turn. Each flow is written as a
*journey*: what the consumer is trying to do, the steps, and what claudemux
**must** report at each step. This is the spec the code + CLI standardize to.

**Vocabulary.** Three verbs own the loop: `send(text) → cursor`, `wait(opts) →
TurnOutcome`, `messagesSince(cursor) → Message[]`; `ask = send→wait→read`.
`state()`/`progress()` are snapshots of the one fused belief. `TurnOutcome.kind ∈
{completed, awaiting, aborted, budget-exceeded, degraded}`. Lifecycle peers:
`create` (fresh) · `resume` (continue a conversation in a fresh pane) · `adopt`
(re-attach to a *running* pane) · `exists`/`kill`/`list`.

**Status legend.** ✅ verified (surface/acceptance covers it) · ⚠️ works but the
contract needs standardizing/hardening · ❌ gap or bug found — work item.

---

## A. Starting a session

**F1 — First kickoff (build agent). ✅**
*Journey:* daemon spawns a durable build agent and sends its mandate.
*Steps→Expected:* `create({name, cwd, trustWorkspace})` boots (SessionStart hook
gates ready, pane-settle guards the first send) → `agentSessionId` surfaced and
**persisted by the consumer** → `send(mandate)` returns a real cursor →
`wait()`→`completed` → `messagesSince(cursor)` is the reply. Events: a
`session.started`-equivalent is the returned handle; turn lifecycle is on the hook
channel (`progress().hookChannelHealthy === true`).

**F2 — Untrusted workspace, no opt-in. ✅**
*Journey:* daemon spawns into a folder the agent doesn't trust.
*Expected:* `create` throws `WorkspaceUntrusted` **before any keystroke** (no
persistent trust flag written). The consumer surfaces it / decides to opt in.

**F3 — Untrusted workspace, opted in. ✅**
*Expected:* `create({trustWorkspace:true})` auto-dismisses the trust dialog (`1`+
Enter) and boots. The grant is the consumer's explicit choice.

**F4 — claude not logged in. ✅**
*Expected:* `create` throws `LoginRequired` (the login-method dialog is a setup
error, never auto-answered) — a clean typed throw, not a 60 s hang.

**F5 — Caller-chosen conversation id. ✅**
*Journey:* daemon wants a deterministic id (its own DB key).
*Expected:* `create({agentSessionId})` validates it's a v4 UUID, runs under it,
surfaces exactly it. Re-using it later is `resume`, not `create`.

**F6 — Id collision (id already live elsewhere). ✅**
*Expected:* the agent refuses to run two panes under one id and exits during boot
→ `AgentExitedDuringBoot` **carrying the id**, fast (not a `ReplTimeout`). The
consumer should `adopt` the live one instead.

**F7 — Theme-picker on first ever boot. ✅**
*Expected:* the theme dialog is auto-dismissed (Enter); boot continues. Dialogs
are always handled before any ready check.

**F8 — Boot under contention (N parallel spawns). ✅**
*Journey:* daemon spawns a fleet at once; the box is busy.
*Expected:* each session boots independently or fails with an honest
`ReplTimeout` — never crosstalk, never a false-ready. *Standardized (S7):*
documented (README "Boot concurrency is yours") that claudemux exposes no
spawn-throttle — it reports per-session readiness honestly but does not throttle;
serializing/semaphoring N concurrent `create()`s is the consumer's policy
(mechanism, not policy — same north star as patience).

---

## B. Delivering a turn

**F9 — Fast turn (completes before the first poll). ✅**
*Journey:* a one-word reply finishes in <150 ms.
*Expected:* `wait()` still returns `completed` — it arms on the post-submit
baseline divergence (the stateless-CLI path), not only on an observed `working`
frame. No false `budget-exceeded`.

**F10 — Lost Enter during the boot race. ✅**
*Journey:* the send lands while the REPL is still painting; the Enter is dropped,
so the paste sits in the composer un-submitted and no user record is written.
*Standardized (S3):* `send` anchors the cursor on the user record it produced; if
that record never appears AND the message wasn't queued, `send` now OWNS the
recovery — it re-fires Enter ONCE (`submitOnce`, which submits the existing draft
and never re-pastes, so it can never duplicate the body) and re-anchors. Only if
that still finds nothing does it return the exported **`DELIVERY_UNCONFIRMED`**
sentinel (S11) — detectable, reads empty against `messagesSince`/`turnComplete`,
so the consumer re-sends. This folds Posse's hand-rolled `deliverWithConfirm`
recovery into the substrate. Unit-tested deterministically (a backend that drops
the first Enter → send recovers a real cursor with exactly one retry Enter).

**F11 — Multi-line / pasted prompt. ✅**
*Expected:* delivered as ONE logical turn (bracketed paste + a separate Enter) —
never per-line submit. (`docs/decisions/0001`.)

**F12 — Send while a turn is still working. ✅**
*Journey:* the consumer (or a human) sends B before A finished.
*Standardized (S4):* the bytes are delivered and claude **queues** B (it shows
"Press up to edit queued messages"); B runs after A. The danger was that B's user
record doesn't flush until B starts, so `send` returned `DELIVERY_UNCONFIRMED` —
indistinguishable from a *lost* send, so a re-send-on-unconfirmed consumer would
**double-run** B. `send` now returns the distinct **`DELIVERED_QUEUED`** sentinel
when the agent's `queued` pane affordance is present: "accepted, will run, don't
re-send." Verified live on 2.1.162 (`scripts/flows-send-while-busy.mjs`): a send
into a working session returns `DELIVERED_QUEUED` and the queued turn then runs.

**F13 — Empty / whitespace send. ✅**
*Standardized:* documented in the `send()` contract — an empty/whitespace body is
delivered but a no-op turn (the agent ignores an empty submit), so no record is
written and the return is `DELIVERY_UNCONFIRMED` (nothing to anchor). The consumer
guards against empty sends if a no-op turn would confuse its loop.

---

## C. Reading & knowing it's done

**F14 — Send → wait → read (the core loop). ✅**
*Expected:* on `completed` the reply is **readable** — the flush skew is closed,
so `messagesSince(cursor)` is race-free.

**F15 — Multi-turn isolation. ✅**
*Journey:* daemon sends A, reads it, sends B.
*Expected:* `messagesSince(cursorB)` returns ONLY turn B (causal parent-chain,
bridges 2.1.162 attachment records) — the prior turn never leaks.

**F16 — Tool-using turn. ✅**
*Expected:* `progress().phase` walks `prompt→tool→composing→done`;
`messagesSince` includes `tool` + `tool-result` parts (neutral, summarized).

**F17 — Long-thinking turn (minutes of silence, no tool). ✅**
*Journey:* an extended-reasoning turn (or a long foreground tool) writes no
transcript for a while. *Expected:* NOT flagged stuck. *Standardized (S8):* the
stuck-detector's early-exit is gated on `state==="unknown" && !toolInFlight` — a
`working` pane (the live `esc to interrupt` spinner) or a tool in flight is never
early-aborted, and the heartbeat keys on the pane fingerprint so the still-
animating spinner (its elapsed counter ticks) keeps it alive even if a frame
classifies `unknown`. Only a genuinely FROZEN unknown pane fails fast (`idle`).
Locked by unit tests (`src/io/wait.test.ts`, injectable `stuckMs`) AND a live
scenario E (a ~45s working turn → `completed`) in `scripts/acceptance-suite.mjs`.

**F18 — Streaming read (read mid-turn). ✅**
*Journey:* daemon tails partial output before the turn ends.
*Expected:* `messagesSince(cursor)` mid-turn returns the partial messages so far;
`progress().phase` is `tool`/`composing`. The consumer streams; `wait` later
confirms `completed`.

---

## D. Resume, restart & crash recovery (the headline)

**F19 — Clean resume. ✅**
*Journey:* daemon stops a build agent, later continues the SAME conversation.
*Steps→Expected:* `kill` the pane → `resume({name2, agentSessionId})` spawns a
fresh pane with the agent's resume mechanism → history intact (recall proves it).
`source:"resume"` is on the SessionStart edge.

**F20 — Crash MID-TURN, then resume (start → run long → kill tmux → resume). ✅ (S9+S2)**
*Journey:* the daemon's box loses the tmux server while a build agent is
mid-essay; the daemon restarts and continues the conversation.
*Steps→Expected (the standardized contract):*
  1. mid-turn `state()` = `working`; `exists()` flips to **false** the instant the
     server dies.
  2. The crashed turn leaves a **dangling user prompt with no assistant reply** in
     the transcript. → `messagesSince(inFlightCursor)` returns `[]`. **This is how
     the consumer detects "the previous command did not complete."**
  3. `resume({name2, agentSessionId})` → history (everything before the essay) is
     intact; recall works.
  4. **What to re-send:** the in-flight prompt (the essay) — the consumer compares
     its last-sent cursor against `messagesSince` (no reply ⇒ re-send it). Earlier
     completed turns are NOT re-sent.
*✅ Fixed (S9):* before, after resume `state()`/`progress()` reported **`working`** forever —
the crashed turn's `prompt-submit` hook edge never got a matching `stop`, so the
stale edge poisons the belief even though the pane is idle. *Standardize (code):* a
turn that ends without a `stop` edge (crash/interrupt) leaves the hook lifecycle
stale; a **stable idle pane overrides a stale hook-`working`**. Plus: give the
consumer a clean "last turn incomplete" signal so "what to re-send" isn't
hand-rolled (see F23).

**F21 — Daemon restart, pane SURVIVED. ✅**
*Journey:* the daemon process restarts; the agent's tmux pane is still alive.
*Expected:* `adopt({name})` re-attaches and **recovers the agentSessionId** from
session-meta → transcript + hooks locatable → resume tailing. It does NOT re-spawn
or re-kick (the agent kept its context). (Posse reads `emitted =
transcript.length` so old items aren't re-folded.)

**F22 — Daemon restart, pane DIED. ✅**
*Standardized:* `adopt` throws `SessionGone` when the pane isn't alive; the consumer
then `resume`s into a fresh pane from the persisted id. The `adopt`-fails-then-
`resume` restart path is documented (README "Resume vs adopt vs fork") and shown
end-to-end in `examples/adopt-after-restart.ts`; the crash→resume mechanics are
live-verified in `scripts/flows-recovery.mjs`.

**F23 — Re-hydration: don't re-kick, DO re-send the in-flight prompt. ✅**
*Journey:* Posse's exact rule — on a crash-revive, don't re-send the kickoff (the
agent has context); only re-send what was in flight.
*Standardized:* `turnComplete(cursor): boolean` is the first-class detector —
`false` ⇒ that turn was lost (re-send it), `true` ⇒ it completed (leave it). The
consumer applies it per-cursor: the kickoff cursor reads `true` (don't re-kick),
the in-flight cursor reads `false` (re-send). Recipe in README §"Resuming a
conversation after a crash"; live-verified in `scripts/flows-recovery.mjs` (the
dangling-turn ⇒ `turnComplete === false` case). The "don't re-kick" decision is
consumer policy applied over this substrate primitive.

**F24 — Resume an id that is STILL live elsewhere. ✅**
*Expected:* the agent refuses (two panes, one conversation) → `AgentExitedDuringBoot`.
The consumer should `adopt` the live pane instead of `resume`. (Same guard as F6.)

**F25 — Resume after compaction. ✅**
*Journey:* a long build conversation compacted; daemon resumes it.
*Verified (S13):* live against claude 2.1.162 — after a `/compact` boundary, a
follow-up turn correctly recalls the pre-compaction secret, and `messagesSince`
on a pre-compaction cursor still returns the post-compaction turn. The transcript
is append-only as claimed (compaction summarizes the *context window*; the on-disk
`.jsonl` keeps an unbroken linear `parentUuid` chain), so `resume` + history recall
hold. (`/compact` is the manual proxy for auto-compaction; the on-disk record model
is the same.)

**F26 — Bare `--resume` (id we can't know up front). ✅**
*Expected:* `agentSessionId` surfaces as `undefined` honestly (the one path we
can't know it); transcript-dependent reads degrade rather than fabricate.

**F27 — Fork a conversation. ✅ (recipe + honest caveats)**
*Journey:* daemon wants to branch an exploration from a build agent's history.
*Verified (S6):* `create({ extraArgs: ["--resume", id, "--fork-session"] })` branches
into a NEW conversation; both continue independently; the new id is unknowable up
front (`agentSessionId` undefined — confirmed live). *Documented limitation:*
because the fork's id is unknowable, claudemux locates its transcript only via the
first hook edge, so the **first `send()` can return `DELIVERY_UNCONFIRMED`** (no
anchor before the path resolves) and `messagesSince`/`turnComplete` are unavailable
until then. No first-class `fork()` peer — it's a documented `extraArgs` recipe
with these caveats (README "Resume vs adopt vs fork"); prefer `resume()` for a
fully readable branch.

---

## E. Interrupt & replace

**F28 — Interrupt a working turn. ✅**
*Journey:* the founder changes their mind mid-generation.
*Expected:* `interrupt()` delivers ESC; `wait()` resolves `{kind:"aborted"}`;
`state()` reads `unknown` (claude restores the cut draft into the composer — not a
clean idle). The session stays responsive.

**F29 — Interrupt then send a replacement (the draft footgun). ✅ (documented)**
*Journey:* interrupt, then send a corrected prompt.
*Standardized:* a naive `send` pastes ONTO the restored draft and submits the
concatenation — documented, with the claude-specific "interrupt-and-replace"
recipe (clear the composer by observing it empty, then send) in README
"Interrupting a working agent." Deliberately NOT folded into the neutral verb
(mechanism, not policy — same reason `interrupt()` bundles no follow-up). An opt-in
`clearComposer` helper is a possible future convenience, not a correctness gap.

**F30 — Interrupt when idle / stale "Interrupted" in scrollback. ✅**
*Journey:* interrupt fired on an idle session, or a *new* turn runs while a prior
"Interrupted" line is still on screen (incl. after resume replay).
*Expected:* NO false `aborted` — `interrupted` only counts when the pane is the
post-interrupt draft (`unknown`), never on an idle/working pane (the scrollback
guard; the resume-replay bug this fixed).

---

## F. Patience, budget & stuck

**F31 — wait with a short budget on a genuinely slow turn. ✅**
*Expected:* `wait({maxMs})` returns `{kind:"budget-exceeded", reason:"max"}` — a
returned verdict, **never a throw**. The consumer keeps waiting (poll again) or
escalates. "Progress is the agent's, time is the policy's." *Standardized
(patience realignment):* the budget is the CONSUMER's — the library owns no
default. `maxMs` is wall-clock; `timeoutMs` is a deprecated alias. With no bound,
`wait()` blocks until terminal and invents no deadline (RFC §5).

**F32 — wait on a wedged session (crashed mid-turn, no progress). ✅**
*Expected:* `wait({idleMs})` → `{kind:"budget-exceeded", reason:"idle"}` —
distinguishes *stuck* (no progress for the consumer's `idleMs`) from
*still-working* (a `working` pane or tool-in-flight never trips `idleMs`; only a
genuinely frozen/`unknown` pane does). *Standardized:* the THRESHOLD is the
consumer's (no library `STUCK_MS`); the library only distinguishes
stuck-from-working. Composes with F20 — a resumed session's stale `working` edge
is overridden by the idle pane, so a settled box isn't mistaken for wedged.
Locked by unit tests (`src/io/wait.test.ts`, injectable via `idleMs`).

**F33 — wait hits an awaiting state (permission prompt). ✅**
*Journey:* the agent asks to run a tool that needs approval.
*Expected:* `wait()` returns `{kind:"awaiting", on:"permission-prompt"}`
immediately (actionable, no settle); `respond(choice)` answers it; the next
`wait()` resolves `completed`. *Standardized (S5):* the classifier matches the
`Do you want to …?` header AND the `❯ 1.` menu (both required — a reply tail or
streaming frame can carry the header phrase in the 40-row capture). `respond()`
fires the agent-mapped digit and self-confirms the menu cleared before returning,
so the `respond → wait` loop is race-free. Verified live against authenticated
claude 2.1.162 (`scripts/flows-permission-prompt.mjs`, approve + deny).

---

## G. Observe degradation (honest, never silent)

**F34 — Hooks off. ✅**
*Journey:* the consumer manages its own hooks (`create({hooks:false})`).
*Expected:* `progress().hookChannelHealthy === false` (honest degrade);
`wait`/`state`/`messagesSince` still work via the pane + transcript fallback. The
done-signal is the pane-based settle (which trails the flush), so reads stay
race-free.

**F35 — Read a session that is GONE. ✅**
*Journey:* the consumer calls `state`/`wait`/`messages` after the pane died.
*Expected:* the typed `SessionGone`/`BackendUnreachable` propagates (a failed
capture means gone — terminal), NOT a silent `unknown`. The consumer reattaches or
resumes. Uniform across every read (it used to differ: `state` threw, `progress`
degraded).

**F36 — Parallel scale (many concurrent sessions). ✅**
*Journey:* the daemon drives dozens of agents at once.
*Expected:* per-session handles are independent; every handle method is
mutex-gated so concurrent `send`/`wait` on one session can't interleave bytes;
two consumers on distinct namespaces with the same names coexist. (Backend is a
per-process isolated socket.)

---

## H. What can't be seen but WILL bite (latent traps)

These pass every demo. They have no symptom until a session is long-lived, resumed,
duplicated, run cross-host, or crashed at the wrong instant — then they bite
silently. The tmux-crash→stale-edge (F20) is the archetype; here are its siblings.

**F37 — Resume boots "ready" on a STALE `session-start` edge. ✅ (S9)**
*Hidden:* the hook rendezvous is keyed by `agentSessionId` and **reused across
resume** — the crashed session's `session-start` is still in the file. Boot's gate
is `readHookEdges(...).some(e => e.event === "session-start")`, which matches the
**old** edge the instant resume starts → the hook gate is always-true on resume,
so boot silently falls back to pane-settle only (R5 defeated). *Bites when:* a
future change trusts the hook gate without the pane-settle, or the resumed REPL's
replay outlasts the settle. *Standardize:* boot must count only a `session-start`
**newer than this boot** (or the rendezvous must be per-pane, not per-id — see S9).

**F38 — The reused rendezvous conflates pre-crash and post-resume lifecycles. ✅ (S9)**
*Hidden:* same root as F37/F20. After resume, the rendezvous holds the crashed
turn's unclosed `prompt-submit` AND the new session's edges. `believe()` computes
`phase`/`lastStopAt` across BOTH → stale `working`, wrong `lastStopAt`. *Bites:*
every resumed session's belief is poisoned by prior-life edges. *Standardize:* the
belief must reset at each `session-start` boundary — only consider edges since the
latest one. (Root fix for S1 + the cleanest fix for F20/F37.)

**F39 — Unbounded rendezvous + transcript growth → O(n) per poll. ✅ (S10)**
*Hidden:* both files are append-only and never truncated. `readHookEdges` /
`readThread` parse the WHOLE file on every `progress`/`wait` poll. A build agent
running for days with thousands of edges/messages makes each poll O(n). *Bites:*
latency + memory creep invisible in a 5-minute test, fatal over a 3-day session.
*Standardize:* tail-read (only the last N lines / since an offset), or cap the
scan window.

**F40 — The count-fallback cursor `"0"` reads the ENTIRE history. ✅ (S11)**
*Hidden:* when `send`'s cursor anchoring fails (lost Enter, F10), it returns the
string `"0"`. `messagesSince("0")` is the legacy count path → `all.slice(0)` =
**every message ever**, not "since my send." *Bites:* a consumer stores `"0"`,
later asks for "new messages," and gets the whole conversation — looks like a
flood of duplicates, or it re-acts on old turns. *Standardize:* a failed anchor
should return a sentinel the consumer can DETECT (DeliveryUnconfirmed, S3), not a
cursor that silently means "everything."

**F41 — `anchorOwnTurn` anchors the WRONG turn on duplicate prompts. ✅ (already correct)**
*Hidden:* the cursor is found by matching the first 80 chars of the sent text
against user records. Two build agents with identical kickoffs, a retry of the
same prompt, or a prompt that's a prefix of an earlier one → the anchor can land
on the OLD record. *Bites:* `messagesSince(cursor)` returns a stale/other turn.
*Standardize:* anchor on the NEWEST matching record after the pre-send id-set (it
already excludes `beforeIds`, but a same-text record from much earlier in the same
session can still collide) — prefer position/recency + the before-set, and document
the dup-prompt caveat.

**F42 — Cross-host clock skew breaks the done-trigger. ⚠️ (documented single-host assumption)**
*Hidden:* `wait`'s completion uses `lastStopAt >= waitStart`, comparing the hook's
`date +%s.%N` (the session host's clock) against the consumer's `Date.now()`. On a
different host/container with clock skew, a real `stop` can read as "before" the
wait → hooks never fire completion (falls to pane), or a stale stop reads as
"after" → premature. *Bites:* only when claudemux and the agent run on different
clocks (a distributed Posse). *Standardize:* derive "this turn" from edge ORDERING
(a `stop` after our `prompt-submit`), not wall-clock comparison.

**F43 — Compaction snaps the parent chain. ✅ (feared break did NOT reproduce)**
*Was hidden:* the worry that compaction leaves later records' `parentUuid`
referencing summarized-away records, so `descendantsOf` walks a broken chain and
`messagesSince` drops the tail. *Verified (S13):* on claude 2.1.162 the chain does
NOT break — the on-disk transcript is append-only and the linear `parentUuid` chain
stays intact across a `/compact` boundary (the summarized records remain on disk),
so a post-compaction turn still descends from a pre-compaction cursor. *Hardened
anyway (defense-in-depth):* `descendantsOf` now classifies each lineage and, if a
chain hits a MISSING parent (a hole, e.g. a future record-format change that *did*
drop a record), falls back to position for the post-cursor tail — provably without
re-including the late-flush prior reply (which roots cleanly, never orphaned).
Unit-tested (orphan tail kept; late-flush still excluded) + live-verified.

**F44 — Interrupt-after-done is a silent no-op. ✅ (documented hazard)**
*Hidden:* out-of-process latency lets a turn FINISH between the consumer deciding
to interrupt and the ESC landing (the scar in `[[interrupt-verify-working-state-immediately]]`).
ESC then just clears the idle box; the turn already `completed`. *Standardized:*
documented (README "Interrupting a working agent" — the gate is not atomic; gate
on `state()` in one tight in-process sequence, and don't trust a stale prior-process
`working` reading). A harmless no-op, not corruption; surfacing it as a returned
signal is deferred (the documented gate covers the consumer's need).

**F45 — A legit turn longer than the wait budget looks like a failure. ✅**
*Hidden:* a big build turn legitimately exceeds the consumer's `maxMs` →
`budget-exceeded{max}`. A naive consumer treats it as failure and **re-sends** →
two concurrent turns / duplicated *side effects* (the worst kind). *Standardized
(S15):* README makes `budget-exceeded` unmistakably "may still be running — do NOT
blindly re-send"; it routes the consumer to `progress()` (`toolInFlight` / a
freshly-advancing `transcriptCount` ⇒ slow-but-alive, keep waiting; long-flat ⇒
likely wedged, `interrupt()` not re-send) and to re-send only a `turnComplete ===
false` turn. (Also: the library now owns no default budget — `budget-exceeded`
only happens against a bound the consumer chose. F31/F32.)

**F46 — Post-restart cursor with a recovery miss → silent empty. ✅ (documented distinguisher)**
*Hidden:* a cursor (uuid) is durable across the consumer's restart, BUT if `adopt`
couldn't recover the `agentSessionId` (session-meta never written — `hooks:false`
create, or a non-claudemux session), the transcript is unlocatable →
`messagesSince(validCursor)` returns `[]`, identical to "no new messages."
*Standardized:* the `messagesSince`/`turnComplete` docstrings now state the
disambiguator explicitly — gate on `agentSessionId !== undefined` first: `undefined`
⇒ reads are blind (can't locate the transcript), not "nothing new." A distinct
typed signal would be cleaner, but the documented gate closes the silent-bite.

**F47 — `kill()` mid-turn discards the in-flight reply. ✅ (documented)**
*Hidden:* `kill` is immediate; an assistant turn mid-stream is lost (transcript
has a dangling prompt, same shape as a crash). *Standardized:* the `kill()`
docstring now states it is a **hard stop, not a drain** — to stop a turn but keep
what it produced, `interrupt()`/`wait()` and read with `messagesSince` first, then
`kill()`. A `drain` option is a possible future convenience, not a correctness gap.

**F48 — Pasting content with control/escape sequences. ✅ (S14)**
*Hidden:* `send` pastes the body via bracketed paste. A prompt containing the
bracketed-paste terminator (`ESC[201~`) or raw control bytes could end the paste
early or inject keys. *Bites:* user/tool content with terminal escapes (logs,
diffs, adversarial input). *Standardize:* sanitize/escape the paste body, or
document the constraint; add a fixture with embedded escapes. (Security-adjacent.)

**F49 — A permission prompt is invisible — looks like a slow turn. ✅**
*Was hidden:* with the classifier empty, a default-mode agent that hit a prompt
mid-turn classified as `unknown`/working → `wait` ran to `budget-exceeded`; the
consumer saw "slow/stuck," not "waiting for me." *Standardized (S5):* the prompt
is now a first-class `awaiting{permission-prompt}` outcome answered by
`respond()`. A subtle second bite surfaced and was fixed here: a *denied* tool
fires `tool-start` but no `tool-end`, so the hook belief stuck at `working`
forever → `wait` still budget-exceeded after the deny. The fused belief now lets
a settled idle pane override that dangling-tool `working` (a real in-flight tool
never shows the idle box). Both branches verified live on 2.1.162.

**F50 — claude version drift silently breaks parsing. ✅**
*Hidden:* `isReady` keys off SGR-dim styling; `parseMarker`/`parseTranscriptLine`
key off claude's payload/record shapes. A claude minor (2.1.161→162 already moved
the parent chain, the placeholder, the payload) can silently break readiness or
message reads. *Standardized (S16):* two tripwires. (1) The agent-seam unit
fixtures are VERBATIM-from-live, so a parser drift fails `npm test`, not a
consumer's prod — re-capture each claude bump; `glyph-canary.yml` probes the `❯`
glyph against *latest* claude on a schedule. (2) A runtime **drift canary**:
`progress().agentChannelHealthy` goes `false` when EVERY observe channel comes up
blind at once against a non-empty pane (classifier `unknown` + no hook edges + no
parsed messages) — the signature of a format moving out from under the parsers.
A consumer alarms on *persistent* `false`. Unit-tested (the triple-blind fires;
any single live channel, or an empty pane, keeps it healthy).

---

## Standardization backlog (what these flows surface as work)

| # | Status | Item | Flows |
|---|--------|------|-------|
| **S9** | ✅ **done** | **Lifecycle-boundary reset (ROOT FIX):** `believe()` + the boot ready-gate consider only edges since the **latest `session-start`** (boot waits for a *new* one via a count baseline). Unit-tested + live-verified (crash→resume reports `idle`, not stale-`working`). | F20, F37, F38 |
| **S1** | ✅ **done** | **Stale-edge override** — subsumed by S9 (a resumed/idle session is no longer judged by a prior life's unclosed `working`). | F20, F32 |
| **S2** | ✅ **done** | **Incomplete-turn signal:** `turnComplete(cursor)` (handle + `claudemux turn-complete` CLI) — `false` ⇒ re-send. Live-verified in the crash-recovery flow. | F20, F23 |
| **(int)** | ✅ **done** | **Interrupt authority:** the handle tracks an interrupt-pending flag (set by `interrupt`, cleared by `send`); `wait`→`aborted`, `state`→`unknown`. Fixes the frozen-spinner mis-read where "esc to interrupt" lingers post-interrupt. | F28, F44 |
| **S3** | ✅ **done** | **Delivery confirmation:** delivered-vs-queued-vs-unconfirmed surfaced via id-cursor / `DELIVERED_QUEUED` / `DELIVERY_UNCONFIRMED` (never a count, S11+S4); and `send` OWNS the lost-Enter retry — `submitOnce` re-fires Enter once (never re-pastes) then re-anchors before reporting unconfirmed. Unit-tested (dropped-first-Enter backend). | F10, F12 |
| **S4** | ✅ **done** | **Send-while-busy:** `send` returns the distinct `DELIVERED_QUEUED` sentinel (vs `DELIVERY_UNCONFIRMED`) when a busy session queued the message — "accepted, will run, don't re-send." Agent owns the `queued` pane affordance (`ClassifierRules.queued`, mirroring `interrupted`); the send path composes it. Unit + live (`scripts/flows-send-while-busy.mjs`). | F12 |
| **S5** | ✅ **done** | **Permission-prompt `awaiting` + `respond()`:** header+menu classifier, `respond("approve"\|"approve-for-session"\|"deny")` (handle + `claudemux respond` CLI), self-confirming so `respond→wait` is race-free. Also fixed the denied-tool dangling-`tool-start` that kept `wait` at `budget-exceeded`. Live-verified on 2.1.162 (approve + deny) via `scripts/flows-permission-prompt.mjs`. | F33, F49 |
| **S6** | ✅ **done** | **Resume recipes:** README "Resume vs adopt vs fork" documents adopt (live pane) / resume (dead pane, same id) / fork (`--fork-session` recipe). Live-verified: resume recall (surface-library), compaction-resume (S13), fork branches into an unknowable id (with the documented read/anchor caveat). | F22, F25, F27 |
| **S7** | ✅ **done** | **Boot-concurrency policy:** documented (README "Boot concurrency is yours") — no spawn-throttle; per-session readiness is honest; serializing N boots is the consumer's policy. | F8 |
| **S8** | ✅ **done** | **Long-think non-stuck:** the stuck early-exit is gated on `unknown && !toolInFlight`; a `working` pane / tool-in-flight is never early-aborted, and the spinner-animated fingerprint keeps the heartbeat alive. Unit-tested (injectable `stuckMs`) + live scenario E (~45s working turn → completed). | F17 |
| **S10** | ✅ **done** | **Bounded reads:** a per-handle `SessionObserver` with incremental `TailReader`s — each `state`/`progress`/`wait`/`messagesSince` poll parses only newly-appended bytes (O(delta), not O(file)). The whole read path (handle + wait) was restructured to defer to it; the old full-read observer functions removed. | F39 |
| **S11** | ✅ **done** | **Cursor sentinels:** `send` returns `DELIVERY_UNCONFIRMED` (exported) on a failed anchor, never a count; an unresolvable cursor reads EMPTY, never the whole transcript. (F46 transcript-unlocatable still reads empty — documented.) | F40, F46 |
| **S12** | ✅ **done** | **Dup-prompt anchoring** — already correct: `anchorOwnTurn` iterates newest-first and excludes the pre-send id-set, so a duplicate prompt anchors the NEW record. | F41 |
| **S13** | ✅ **done** | **Compaction-safe reads:** live-verified the feared chain-break does NOT occur (2.1.162 keeps an unbroken append-only `parentUuid` chain across `/compact`; recall + `messagesSince` hold). Added defense-in-depth: `descendantsOf` classifies lineage and falls back to position for an ORPHANED chain (missing parent), without re-including the late-flush reply. Unit + live. | F43, F25 |
| **S14** | ✅ **done** | **Paste safety:** `sanitizePasteBody` strips bracketed-paste markers + C0/DEL control bytes (keeps `\n`/`\t`) before `load-buffer`. Closes the ESC[201~ break-out injection. | F48 |
| **S15** | ✅ **done** | **Re-send safety:** README makes `budget-exceeded` unmistakably "may still be running — do NOT blindly re-send"; routes to `progress()` (toolInFlight/advancing transcriptCount ⇒ alive) and to re-send only `turnComplete === false`. Reinforced by the patience realignment (no library default budget). | F44, F45 |
| **S16** | ✅ **done** | **Drift canary:** `progress().agentChannelHealthy` (and on the fused belief) goes `false` when ALL observe channels are blind against a non-empty pane (classifier `unknown` + no hook edges + no messages) — the claude-format-drift signature. Any single live channel keeps it healthy; an empty pane is never judged. Unit-tested. | F50 |

**The keystone landed.** S9 + S1 + S2 + the interrupt-authority fix are implemented
and verified live — the crash-recovery loop (F19/F20/F21/F28/F30) now holds against
a clean contract instead of re-deriving Posse's hand-rolled transcript scanning.
Next highest-leverage: **S11** (honest cursors — F40's "count cursor reads
everything" is the next silent footgun), then **S10** (bounded reads for long-lived
sessions), then **S3** (delivery confirmation).
