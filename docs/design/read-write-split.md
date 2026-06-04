# RFC: observe-side evolution — fuse transcript + pane into a progress/state model

**Status:** DRAFT / RFC — actively refined with the founder. Do not implement yet.
**Branch:** `feat/read-write-split`
**Compatibility:** none owed. v0.1.0, no users, internal, declared-unstable. Optimize
for the *correct* interface. Canonical consumer = Posse; claudemux should **subsume
Posse's hand-rolled v2 integration**.

## Motivating incidents (two failure modes, opposite directions)

1. **Pane-only is insufficient.** claude 2.1.161 added ghost placeholder text to the
   empty input box → the `/^❯\s*$/` idle matcher stopped matching → `spawn`/`wait`
   hang to `ReplTimeout`. Scraping a human TUI for machine state drifts on every
   claude UI change (ADR 0005 predicted this).
2. **Transcript-only is insufficient.** Posse's idle gate watched only the JSONL and
   reaped 3 live agents mid extended-thinking — claude flushes content blocks at
   block boundaries, so a 90s thinking block writes NOTHING while the pane shows
   `✻ Mulling… (1m 6s)` ticking (possekit ADR 0015).

Neither source alone is a complete state signal. **They must be fused.**

## Prior art we're standing on (possekit)

- **`docs/oss-extraction-tmux-driver.md`** (2026-05-27): the spec claudemux 0.1.0
  already realizes — the WRITE/drive half. It scoped transcript ingestion OUT as a
  separate library. **This RFC revisits that cut** (see Tension below).
- **v1→v2 lesson — observe, don't depend on cooperation.** v1's `reply`-tool done
  signal was forgettable by the model; v2 replaced it with an always-on JSONL tail.
- **possekit ADR 0015 — the activity-OR.** A progress gate NEVER gates on a single
  signal. Canonical fusion for claude: `transcript-count OR transcript-mtime OR
  pane-hash`. Each covers the others' blind spots (table below).
- **Theorem: "Progress is the agent's, time is the policy's."** The driver exposes
  progress; the consumer owns idleMs/maxMs/patience. No idle-timeout, no auto-reap
  in the library (spec req 24; the 5.5h deadlock was policy-in-the-driver).
- **Readiness is a PANE signal, never transcript-exists** — interactive claude writes
  no JSONL until first input (the "consult deadlock"). Boot stays pane-side. Confirmed.
- **Other load-bearing write-side lessons** (already in or owed by claudemux):
  `exec claude` so no shell lives behind the pane (safety); dialog-check-before-ready
  is a 100%-fail-open invariant; lost-Enter → confirm-delivery; mint `--session-id` so
  the transcript path is known in advance (claudemux's `agentSessionId` — the enabler);
  no interrupt/ESC in Posse (claudemux's `interrupt()` is ahead here).

## The fused signal model (the core proposal)

| Question | Source(s) | Why |
|---|---|---|
| **working / making progress** | **activity-OR**: transcript-count OR transcript-mtime OR pane-hash | each goes silent during real work; fuse them (ADR 0015) |
| **what did it say** (content) | transcript `.jsonl` (assistant text, tool_use/result) | structured ground truth; beats scraping the render |
| **turn done** | transcript turn-boundary, and/or quiescence of the activity-OR | definitive-ish; consumer's patience decides when "quiet == done" |
| **idle / dialog / permission / ready** (boot + modal) | pane scrape | modal states aren't in the transcript; pre-first-turn has no transcript |
| **liveness** | tmux `#{pane_dead}` / `#{pane_pid}` | tmux owns this fact |
| **drive: spawn/send/interrupt/kill** | tmux | only a terminal can drive the real login REPL |
| **patience: idleMs / maxMs / bootDeadline** | **CONSUMER policy** — NOT the library | "time is the policy's" |

Activity-OR blind-spot coverage (from ADR 0015):

| Signal | Captures | Silent during |
|---|---|---|
| transcript count | completed content blocks | mid-block (long thinking streams unwritten) |
| transcript mtime | any file write incl. state stamps | a clean mid-block stretch |
| pane hash | live UI incl. `Mulling…` token counter | a genuinely hung agent (the case we WANT to catch) |

## Hooks — DECIDED: on by default, transparent, opt-out (founder)

Reliability beats owns-no-config purity here ("otherwise we chase bugs like Posse").
claudemux **injects its hook config by default** on its own spawn (via `--settings`,
framed as configuring-our-spawn, the same category as `--session-id`). Requirements:
- **Transparent:** one place returns the EXACT injected fragment (`hookSpec()` /
  `claudemux hooks-config`); documented, inspectable.
- **Opt-out:** `create({ hooks: false })` → no injection; observe degrades to
  pane+transcript-only (still correct, less crisp). Consumer may also supply/merge their own.
- Hooks are an **accelerator on top of** the fused pane+transcript model (the spike proved
  hooks alone can't cover interrupt/boot; ADR 0015 forbids single-signal). They add the fast
  `Stop` done-edge, the `UserPromptSubmit` delivery edge, and the Pre/PostToolUse phase layer.

## THE TENSION to resolve (spec vs ADR 0015)

The extraction spec cut "claudemux = pane state; transcript = separate lib." ADR 0015
proves robust state needs transcript+pane FUSED. So the transcript — at least as a
*signal* — has to come into claudemux. Proposed resolution: **split the transcript's
two jobs.**

- **(a) transcript-as-signal** (count + mtime, fused with pane for the progress/state
  model) → comes INTO claudemux. It's load-bearing for `state()`/`wait()`; can't be
  separated without re-breaking ADR 0015.
- **(b) transcript-as-content** (rich message/tool parsing for the consumer to *display*
  the conversation) → MAY stay a separate concern/library. claudemux reads the
  transcript to know STATE, not to be a conversation-display library.

Open: is (b)'s line right, or does the consumer want `messages()`/`lastMessage()`
content reads as first-class claudemux surface too?

## Interface implications (DRAFT — all open)

- `state()` — becomes the fused classifier (pane + transcript activity-OR), not pane-only.
- `wait()` — exposes a *progress/quiescence* signal; consumer supplies the patience
  (idleMs/maxMs). claudemux must NOT bake an idle policy. (Revisit `ReplTimeout`'s
  default — boot deadline is arguably a transport bound, idle-reaping is not.)
- a progress/activity primitive the consumer's gate consumes (so Posse's
  `waitForFinishOrIdle` becomes "claudemux gives progress, Posse owns the budget").
- `capture()` — pane text stays (visual/diagnostic); content reads are the (b) question.
- `adopt()` — needs optional `agentSessionId` to locate the transcript for a re-adopted
  session, else observe degrades to pane-only.
- gaps from the spec claudemux still lacks: `listClients` (is a founder `tmux attach`ed?),
  `wait` pattern/debounce modes.

## Empirical unknowns (verify on-box against 2.1.161, but Posse already answered most)

1. Transcript flush timing — Posse confirms: block-boundary, NOT streaming; mid-block silence is real (hence pane-hash). ✓ answered.
2. Transcript path — Posse scans `~/.claude/projects/*/<id>.jsonl` rather than computing
   the cwd-slug. Adopt that robustness.
3. Partial lines — try/parse/skip; a 1.5s settle after quiescence before final snapshot.
4. Schema — Posse parses `type:user|assistant`, `message.content[]` text/tool_use blocks.
   No `stop_reason`/result marker relied upon. Fixture both.

## Open questions (for the founder)

1. **Unify vs separate** — does transcript-as-content (b) come into claudemux, or only
   transcript-as-signal (a)? Where exactly is the line?
2. **Hooks** — agree they're an optional later edge, not the foundation? (Posse proves
   the observe model standalone.)
3. **Progress-vs-policy** — refactor so claudemux exposes a progress/activity signal and
   owns NO idle/reap timeouts (only consumer-supplied bounds + a boot transport bound)?
4. **One library or a family** — is this still "claudemux = drive" + a sibling observe
   lib, or does claudemux become the unified drive+observe substrate?

## Product: the turn contract (founder-crystallized)

claudemux = **reliable programmatic Q&A over a long-lived interactive claude**.

> `send(msg)` → the turn runs → resolves to **exactly one typed terminal outcome**,
> and **messages produced since the send** are retrievable.

Terminal outcomes (handled one standard, graceful way — never a hang):
`done` · `needs-input` (question) · `needs-permission` · `crashed` · `usage-exhausted`/`error`.
`still-working` is a *state*, not a forced timeout — patience is the consumer's.

This resolves the unify question: **content (messages-since-send) comes INTO claudemux.**
Posse's thin UI would render claudemux's messages, not re-parse the JSONL.

## Seams as ownership + contracts

Design value (founder): **exactly one place owns/does each thing** (single source of truth).

| Seam | Owns | Contract |
|---|---|---|
| **claudemux core** | turn lifecycle; session identity (id ↔ transcript path) | a turn resolves to **exactly one** typed outcome; messages-since-send complete + deduped; abnormal states are **typed outcomes, never hangs** |
| **Backend** (drive) | spawn/send/interrupt/kill + raw liveness | input delivered as **one logical turn**; backend-neutral vocabulary |
| **Observer** (state truth) | fuse transcript + pane (+ maybe hook) → state/progress/messages | **never single-signal** (ADR 0015); reports **progress, not policy** |
| **Consumer** | policy: patience, what to send next, how to answer question/permission | gets the typed outcome; decides |

Design the **Observer contract first** — done-reliably + messages-since-send + abnormal
outcomes all live there, and it's where the hook decision lands.

## Hard edge cases (founder, from Posse scars)

- **AskUserQuestion disabled** (Posse's default) → the model asks **in chat**, so the
  turn mechanically *completes* (`Stop` fires, messages present) but is semantically
  "waiting for you." claudemux likely *can't* detect this structurally — it's `done` +
  the consumer reads intent. With the tool *enabled*, it's a detectable dialog. So the
  `needs-input` outcome is **mode/config-dependent** — name that in the contract.
- **Permission modes** — `default` / `acceptEdits` / `auto` / `bypassPermissions`
  (founder's default) / `plan`. Which outcomes can even occur depends on mode:
  `needs-permission` is impossible under bypass. The contract must state "outcomes
  reachable in mode X."
- **Operational failures that kept biting Posse** — must be first-class typed outcomes,
  not hangs: turn **timeout** (consumer budget), **usage/credit exhaustion**, **machine
  restart** (→ re-adopt + resume; in-flight turn reconstructed from transcript),
  **claude crash** (`PaneDead`). Resume/re-adopt needs the persisted `agentSessionId`.
- **Thinking vs hung — the hardest one.** Deep thinking can be 5–10 min with the JSONL
  silent; Posse's pane-hash (`✻ Mulling…` counter) is the best discriminator, but a long
  tool call (e.g. a 5-min bash) moves *nothing* in claude's UI yet isn't hung. Honest
  stance: claudemux exposes the **richest possible progress signals** (count, mtime,
  pane-hash, maybe a hook heartbeat) and **does not claim to define "hung"** — the
  consumer's patience does. "Progress is the agent's, time is the policy's." The spike
  must measure: *during deep thinking, what moves?*

## Hook research spike (running on this box, isolated socket)

Testing what the turn contract depends on against 2.1.161, bypassPermissions:
which hook events actually fire interactively (`Stop`/`Notification`/…); `Stop`
latency vs prompt-return vs transcript final-write (doorbell before package?);
behavior on interrupt / blocked-on-input; `--settings` injection mechanics; and
the thinking-vs-hung signal behavior. Findings appended below as data lands.

### Spike findings (2.1.161, bypassPermissions, isolated socket — all confirmed live)

- **Hooks fire reliably in the *interactive* session.** Observed firing: `SessionStart`
  (only AFTER trust dismissal), `UserPromptSubmit` (+0.05–0.10s after Enter — a clean
  *delivery-confirm* edge, could replace Posse's transcript-echo polling), `PreToolUse`
  / `PostToolUse` (wrapping each tool), `Stop` (turn end, ~1.7s on a trivial turn). Also
  a stray `SubagentStop` after a Stop on a non-subagent turn (anomaly — flag, don't rely).
- **Payload hands us the truth:** `session_id`, **`transcript_path`**, `cwd`,
  `permission_mode`, `effort`, `hook_event_name`. With hooks on, we don't derive the
  transcript path — claude gives it.
- **`Stop` is fast + harness-fired** (model can't forget it). **Doorbell precedes package:**
  transcript final mtime landed ~110ms AFTER `Stop` ran → read-after-Stop needs a brief
  settle/retry (matches Posse's 1.5s settle instinct).
- **Thinking-vs-hung — SOLVED well enough:** during a 12s tool exec, transcript count+mtime
  FROZE but **pane-hash changed every poll** (claude ticks an elapsed counter) AND
  `PreToolUse`-without-`PostToolUse` marks "a tool is legitimately in flight." Hooks add a
  **semantic phase layer** (`prompt → tool↔tool → composing → Stop`) over Posse's raw
  activity-OR. A genuine hang = none of {hook transition, pane-hash, transcript} move.
- **Interrupt (ESC): NO `Stop` fired.** Pane showed `⎿ Interrupted · What should Claude do
  instead?` + ready `❯`. So `aborted/interrupted` MUST be a pane signal, not a hook. Hooks
  alone can't drive the outcome union. (Confound: the test `sleep 60` was blocked by a
  tool-guard in this claude; re-verify on a clean long turn.)
- **Idle rendering is FLAKY within a version:** bare `❯ ` here vs `❯ Try "edit…"` ghost
  text on the founder's Mac, same 2.1.161. Pane-only idle isn't just version-fragile — it's
  environment-flaky. Strongest argument yet for fusing signals.
- **Boot stays pane-only:** trust dialog live-confirmed the bare-`❯` fail-open trap; no
  transcript until first turn; `SessionStart` fires only post-trust.
- **Incidental:** this claude blocks standalone `sleep` via a tool-guard — consumer claude
  configs vary; the substrate can't assume tool behavior.

### Spike 2 findings (§9 follow-up — verify, never assume; isolated socket, sessions untouched)

- **Permission prompt → NO timely hook.** In `default` mode a `Write` suspended the turn
  (`PreToolUse` fired, no `PostToolUse`, no `Stop`); pane showed `Do you want to create…? ❯
  1.Yes/2.Yes,allow all/3.No`. **No `Notification` for the first ~12s; it fired by ~65s.** So
  `awaiting:"permission"` is **pane-detected (instant)** with `Notification` as a slow (~60s)
  backstop — the hook state is identical to a long-running tool. Pane-required for prompting
  modes; **moot under bypassPermissions** (founder's default → no prompts). Esc cancels a prompt.
  (Note: this claude auto-ran `echo` in default mode — simple tools don't gate here.)
- **Interrupt re-confirmed (no guard confound): ESC fires NO `Stop`.** Pane `⎿ Interrupted ·
  What should Claude do instead?` only. → `aborted:"interrupted"` from in-process flag / pane,
  never a hook.
- **Compaction (`/compact`) is APPEND-ONLY — C2 premise NOT confirmed.** File GREW (39→52 lines,
  same session-id, no fork); old records not rewritten. So a count/offset cursor is **not**
  invalidated by manual compact, *and* **`PreCompact` fires** as an explicit signal. The
  red-team's "compaction silently rewrites → cursor lies" is unconfirmed for `/compact`.
  ⚠ Auto-compaction at context-limit NOT tested — still open; treat with caution.
- **Transcript schema is RICH — ~20 record types**, not `user`/`assistant` only: `message`,
  `text`, `thinking`, `tool_use`, `tool_result`, `file-history-snapshot`, `permission-mode`,
  `mode`, `bridge-session`, `ai-title`, `deferred_tools_delta`, `skill_listing`, `system`,
  `attachment`, `last-prompt`, … The parser must target conversation records specifically and be
  heavily fixtured; `message` vs `user`/`assistant` needs dedicated study.
- **AskUserQuestion ENABLED is detectable**: `PreToolUse` with `tool_name:"AskUserQuestion"` +
  pane dialog, suspends (no Stop). DISABLED (Posse default) → asks in chat → mechanically
  `completed`, structurally undetectable (confirms C8).
- **Boot/trust mechanism identified:** trust persists at `~/.claude.json` →
  `projects["<dir>"].hasTrustDialogAccepted`. Pre-trust → hook-only boot is *mechanically*
  possible; **end-to-end skip-validation DEFERRED for safety** (won't read-modify-write the
  live file with 5 sessions running). Not assumed — flagged as verified-location / unproven-skip.
- **Hook events valid in 2.1.161** (claude accepted all 9 wired): SessionStart, SessionEnd,
  UserPromptSubmit, Stop, SubagentStop, Notification, PreCompact, PreToolUse, PostToolUse.
  Observed firing: all but SessionEnd (fires on end). A stray `SubagentStop` recurs after `Stop`
  on non-subagent turns — anomaly, don't rely on it.

### Spike 3 + Anthropic docs (MCP / skills / slash / compaction — verified)

- **Auto-compaction: founder's hypothesis CONFIRMED by docs.** Per
  [context-window.md](https://code.claude.com/docs/en/context-window.md) +
  [sessions.md](https://code.claude.com/docs/en/sessions.md): compaction (manual `/compact` AND
  auto-at-limit) replaces the in-memory **context window** with a summary; the on-disk `.jsonl`
  is **append-only ALWAYS**, **never rewritten/truncated**, **session-id never changes**. → the
  **C1 cursor-invalidation risk is CLOSED**: a byte-offset/count cursor is durable across
  compaction. The nonce anchor still matters for *rapid-send attribution*, but not for compaction.
  (Survives compaction, per docs: system prompt, CLAUDE.md, auto-memory, invoked skill bodies
  capped ~5K tokens each.)
- **MCP works in driven sessions** (empirical: `/mcp` showed 5 servers, `Notion ✔ connected ·
  16 tools`). Docs: MCP behaves identically interactive vs headless; configured via
  `--mcp-config` / `.mcp.json` / `~/.claude.json` / settings; MCP tool calls fire
  `Pre`/`PostToolUse` like any tool. → claudemux must **pass `--mcp-config` through** (it
  already passes extraArgs) and the parser must handle `mcp__<server>__<tool>` tool_use records.
- **Slash commands + skills work in driven sessions** (empirical: `/compact`, `/mcp` ran; the
  `/` palette listed skills as commands — `/claude-api`, `/advisor`, `/autofix-pr`, …). Skills are
  user-invoked (`/skill-name`) or model-invoked; both work via send-keys.
- **Transcript schema is UNDOCUMENTED/UNVERSIONED** (docs: "each line is a JSON object for a
  message, tool use, or metadata entry" — that's all). Records carry a `version` field (e.g.
  `"2.1.150"`). → parser must be **reverse-engineered + fixtured + keyed on `version`**; this is a
  named maintenance risk (a claude release can change the shape with no documented policy).

## Converged design decisions (spike + two persona reviews)

The OSS-architect and Posse-builder reviews independently converged. Decisions now firm:

1. **Outcome model = stable outer kind + open inner reason** (architect), so a new claude
   failure is a non-breaking *data* change, never union churn:
   ```ts
   type TurnOutcome =
     | { kind: "completed"; messages: Message[] }
     | { kind: "awaiting"; on: AwaitKind; messages: Message[] }   // AwaitKind: "permission"|"question"|string
     | { kind: "aborted";  reason: AbortReason }                  // "pane-dead"|"interrupted"|string
     | { kind: "budget-exceeded"; messages: Message[] }           // consumer patience expired; agent may still be live
     | { kind: "degraded"; reason: string };                      // usage-exhausted / rate-limited / error escape hatch
   ```
   `still-working` is NOT here — it's a `state()`, the outcome only resolves on leaving working.
   Add `reachableOutcomes(mode, askUserQuestionEnabled)` — `needs-permission` is impossible
   under bypass; `awaiting:"question"` is undetectable when AskUserQuestion is disabled (the
   model asks in chat → mechanically `completed`). Mode-reachability is a typed, queryable fact.
2. **`send()` returns a durable, process-independent cursor; `messagesSince(cursor)` returns
   neutral `Message[]`** (builder's #1 — the actual deletion of his `transcript.ts`+dedup).
   The cursor must survive serialization so it re-anchors after a daemon reboot. NOT
   wall-clock/mtime (same-ms self-echo lands on the wrong side).
3. **`progress()` exposes the RAW activity-OR in one cheap read** (builder's #2 — the deletion
   of his `defaultActivityProbe`): `{ transcriptCount, transcriptMtimeMs, paneHash, paneState }`.
   A boolean `working` can't express "Mulling 5min vs wedged." Library exposes signals;
   consumer owns idleMs/maxMs. This is the concrete form of "progress is the agent's,
   time is the policy's."
4. **Single-owner fixes (architect — already-latent split-brain):**
   - The Observer ABSORBS `io/wait.ts` + `io/baseline.ts` arming/fingerprint machinery — today
     that's a *second* state computation beside `state/classifier.ts`. Don't add transcript
     fusion as a third place; consolidate.
   - The slug rule (`cwd → ~/.claude/projects/<slug>/<id>.jsonl`) lives in **prose ×3, code ×0**,
     and the documented rule is WRONG (spike: `/tmp/cmux-spike` → `-tmp-cmux-spike`). One tested
     `AgentDef.transcript.locate()` in `src/agents/claude.ts`; delete the prose copies.
   - **Observer is agent-AGNOSTIC fusion** taking `AgentDef + Backend` (like `classify()` takes
     `rules`). All claude-version-fragile knowledge — pane predicates AND transcript schema —
     stays in `src/agents/claude.ts` (`AgentDef.transcript.{locate,parseLine,isTurnBoundary}`),
     so rot is isolated to one file.
   - **New grep guard:** ban `jsonl` / `message.content` / `~/.claude` runtime strings outside
     `src/agents/**`, mirroring the existing tmux/claude-string guards.
5. **`wait()` becomes a thin consumer-side helper over `progress()`** with NO default timeout
   (kill `DEFAULT_WAIT_TIMEOUT_MS = 300_000` — library-owned patience, same class as the 5.5h
   deadlock). Boot transport-deadline + the 250ms stabilize debounce are legitimately the
   library's; idle budgets are not.
   - ✅ **DONE (patience realignment).** `DEFAULT_WAIT_TIMEOUT_MS` and the hard-coded `STUCK_MS`
     (30s idle auto-give-up) are removed. `ReadyOpts` exposes the consumer's `maxMs`/`idleMs`
     (both optional, no default); `timeoutMs` is a deprecated alias for `maxMs`. With no bound,
     `wait()` blocks until a terminal belief. The stabilize debounce stays library-side as noted.
     The CLI (a consumer) keeps its own 300s default + a `--idle-ms` flag, so shell ergonomics
     hold. The library now distinguishes stuck-from-working (its job); the *threshold* is the
     consumer's (its job). `progress()` already exposes the same belief for poll-it-yourself use.
6. **Cross-process honesty:** "exactly one outcome per `send()`" holds only within one process
   lifetime. After a reboot nobody holds the promise; `state()` can't tell "is the turn I sent
   pre-reboot still running" (no turn id). Either add a turn id or document the limit; the
   durable cursor (#2) is what makes post-reboot `messagesSince` work.

**Builder's bottom line:** the *write* half already beats his `tmux.ts` (he'd adopt today). The
*observe* half (#2 + #3 + the outcome union) is the unshipped, load-bearing part — without it he
keeps `transcript.ts` + the probes and has only adopted the easy half. **Shipping the Observer is
the whole point.**

## Phasing — TBD after questions + spike + persona review.

### Acceptance findings + human-in-the-loop (real bugs the smoke test hid)

A real acceptance *suite* (multi-turn, tool-use, hooks-off, interrupt) against live
2.1.161 found what the single happy-path 6/6 masked:

- **CURSOR BUG (must-fix): multi-turn `messagesSince` isolation is broken.** The cursor is
  a transcript *count* taken at `send()`, but the transcript **lags the `done`/Stop signal**
  (~110ms doorbell-before-package), so the next turn's cursor anchors before the prior turn's
  reply flushes → it leaks the prior turn's tail. **This proves C1's nonce/own-record anchor
  is necessary, not optional** (deferred as "fine single-threaded" — acceptance falsified that).
  Fix in the focused pass: anchor `messagesSince` on the send's OWN user record (nonce), not a
  pre-turn count; the unit test passed only because it mocked a stable file.
- **Boot is still the fragile, pane-scraping residual** — a `hooks:false` run hit `ReplTimeout`
  at boot (likely the flaky `❯`-vs-ghost-text idle rendering). Boot readiness remains the weak
  spot; the observe-side redesign doesn't touch it.
- (A third "failure" was a bad test assertion — interrupt worked; post-interrupt transcript
  growth is correct. Fixed.)

**Human-in-the-loop input (founder: "I attach tmux / use remote-control and type — answer a
question, steer").** Three input paths into one session: `send()`, a human attaching tmux, and
claude remote-control (phone/web). Design stance:
- **Observe is INPUT-SOURCE-AGNOSTIC — a feature, not a problem.** A human-typed turn lands in
  the transcript as a user record exactly like a `send()`; `messagesSince`/`progress` reflect
  the *true* conversation regardless of author. claudemux observes the session's truth and
  **never fights the human**. A by-hand answer to a question just continues the turn; claudemux
  sees it. Make this explicit.
- Sharpens: (1) the **cursor must tolerate interleaved human turns** (same root as the bug —
  nonce anchor fixes both); (2) **`send()` vs a human's unsent composer text** collides (same as
  interrupt-and-replace); (3) **`listClients`** (detect a human attached, per the extraction
  spec req 12) so the consumer can *pause automation while you steer*.
- Scope: observing human turns = in-scope (truthful state); coordinating around the human =
  consumer policy, which claudemux **enables** (expose "human attached" + the turns) but never owns.
