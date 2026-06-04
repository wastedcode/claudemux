# Session as a state machine — the critical view

**Status:** design analysis (founder-prompted: "is it a state machine? what transitions? what states? what can go wrong?"). Pairs with the boot enumeration.

## The reframe (this is the whole point)

Yes, it's a state machine. But the load-bearing realization: **we do not own it and we
cannot directly observe it.** claude owns the state; we *infer* it through lossy, laggy,
ambiguous channels (pane text, transcript, hook edges). So the real engineering problem is
NOT "implement a DFA" — it's **"track a belief about someone else's state machine, driven by
actors we don't control, through noisy signals — and be honest when we're uncertain."**

Four properties make it not a clean DFA:
1. **Partially observable.** Our "state" is a *belief* derived from signals, each lossy. Same
   observation → multiple true states (the ghost-hint: idle vs draft; `PreToolUse`-no-`Post`:
   tool-running vs permission-blocked vs hung; spinner: thinking vs wedged).
2. **Externally driven.** Transitions fire from *four* trigger sources, not just our `send()`:
   **us** (send/key/interrupt/kill), **the agent** (boots, thinks, runs a tool, finishes, asks),
   **a human** (attaches tmux / remote-control and types), **the environment** (crash,
   usage-exhausted, rate-limit, compaction, network). We must never assume single-source.
3. **Lagging / out-of-order.** Channels disagree in time (hook `Stop` precedes the transcript
   flush ~110ms; transcript records can land out of file order). True state ≠ observed state for
   a window.
4. **Drifting.** claude versions add/rename states and renderings (the ghost-hint that broke
   `isReady`; FM-21 marker rot). The machine itself mutates under us.

**Consequence:** the design must (a) make states *explicit and enumerated*, (b) carry a
*source/confidence* on every read (`hookChannelHealthy` is exactly this), (c) have a
*first-class UNKNOWN/STUCK* state — never a blind hang, and (d) distinguish *progressing* from
*stuck* from *ready*, leaving *patience* to the consumer.

## States

### Boot sub-machine
```
spawn()
  │
  ▼
SPAWNED ──► INITIALIZING ───────────────► READY
  │           (welcome/MCP render,          (idle prompt, STABLE)
  │            pane changing)                  variants: bare `❯ ` · `❯ Try "<hint>"`
  │           │  ▲                              (ghost, delayed, rotating) · NOT `❯ <draft>`
  │           ▼  │ dismiss                      · NOT `❯ 1.` (menu)
  │        DIALOG ─────────────────────────► (loop: more dialogs)
  │         ├─ theme-picker   → Enter
  │         ├─ login          → THROW LoginRequired           (terminal)
  │         ├─ workspace-trust→ gate: "1"/Enter | THROW WorkspaceUntrusted
  │         └─ UNKNOWN modal  → ??? (today: spin → ReplTimeout; should: STUCK + pane)
  ▼
EXITED (process died) → AgentExitedDuringBoot        STUCK (no progress, unrecognized) → typed, with pane
```

### Session machine (post-READY)
```
        ┌───────────────────────── IDLE ◄───────────────────────────┐
        │                           │  ▲                             │
   /compact│              send() OR human-types                      │ Stop / turn-end
        ▼  │                        ▼  │                             │
   COMPACTING──► IDLE          WORKING ─┴─ (thinking · tool · composing)
                                  │ │ │ │
        interrupt()/ESC ─────────┘ │ │ └──── usage/credit/rate ──► DEGRADED
        ▼                          │ └────── AskUserQuestion ────► AWAITING:question ─► (answer) ─► WORKING
   INTERRUPTED (composer has        └──────── tool needs approval ─► AWAITING:permission ─► (answer) ─► WORKING
     restored text; NOT clean idle)
        │ clear composer
        ▼
       IDLE                         ANY ── pane dies ──► DEAD (PaneDead)
```

### Per-state signal contract (what confirms it · what it's confused with · reliable vs fallback)
| State | Confirmed by | Confused with | Reliable / Fallback |
|---|---|---|---|
| INITIALIZING | pane changing, no stable prompt | premature-ready flash | pane (must stabilize) |
| DIALOG:known | matched dialog string | the ❯-1 default contains bare `❯` (fail-open trap) | pane; dialog-check BEFORE ready |
| DIALOG:unknown | modal-shaped (`❯ N.` / `Enter to confirm` / `[y/n]`) but no known match | a real ready prompt | pane heuristic → **STUCK**, never silent |
| READY/IDLE | bare `❯ ` OR `❯ <dim ghost hint>`, stable | `❯ <real draft>` (NOT idle); `❯ 1.` (menu) | **hook SessionStart / progress phase=done** ; pane(`isReady`, ANSI-dim-aware) fallback |
| WORKING | hook edges (prompt/tool/compose); `esc to interrupt` | wedged (no signal) vs slow | hook phase ; pane `esc to interrupt` fallback |
| AWAITING:permission | pane `Do you want to…?` | a long-running tool (`PreToolUse`-no-`Post`) | **pane** (hook `Notification` is ~60s late) |
| AWAITING:question | `PreToolUse` tool=AskUserQuestion + pane dialog | a `completed` turn if tool disabled (asks in chat) | hook tool_name + pane |
| INTERRUPTED | pane `⎿ Interrupted` | idle (`❯` returns) | **interrupt-pending flag** (we did it) ; pane fallback |
| COMPACTING | pane progress bar | working | pane ; `PreCompact` hook |
| DEGRADED | pane/transcript error markers | done | transcript/pane |
| DEAD | `#{pane_dead}` / `Pane is dead (…)` | session-gone | tmux fact |
| UNKNOWN/STUCK | none of the above for too long | any | **first-class typed state + pane snapshot** |

## What can go wrong (failure taxonomy)
- **Conflation** — one signal, many states: ghost-hint idle↔draft (broke `isReady` for boot AND
  `state()`/`wait()`); tool-running↔permission-blocked↔hung; spinner thinking↔wedged.
- **Premature classification** — catch a transient (INITIALIZING flash) as READY.
- **Missed transition** — AskUserQuestion-disabled → asks in chat → looks `completed` → consumer
  deadlocks waiting for an answer that's just text.
- **Lost transition** — lost-Enter: we `send()` but the turn never starts → wait forever.
- **Wrong trigger attribution** — a human typed; we credit our `send()` → cursor/turn confusion.
- **Lag/order** — read during the doorbell-before-package window → wrong messages/state.
- **Blind hang on UNKNOWN** — FM-21: an unrecognized dialog → 60s spin → wedged, no signal why.
- **Silent drift** — a version bump renames a marker → silent misclassify (the ghost-hint).
- **Terminal-vs-recoverable mixups** — treat AWAITING/INTERRUPTED/DEGRADED as done or as hung.

## Design implications
1. **Make the machine explicit** — one enumerated `SessionState` (incl. INITIALIZING, DIALOG,
   AWAITING, INTERRUPTED, COMPACTING, DEGRADED, DEAD, **UNKNOWN/STUCK**), not implicit if-checks.
2. **UNKNOWN/STUCK is first-class — never a blind hang.** Can't classify (unrecognized modal,
   no progress, signals disagree) → enter a typed stuck state carrying the pane snapshot; the
   consumer/human intervenes. Kills the FM-21 wedge.
3. **Every state read carries source + confidence** — hook-backed (reliable) vs pane-fallback
   (best-effort), surfaced (`hookChannelHealthy`). Don't assert liveness a signal can't back.
4. **Progress-vs-stuck, not happy-vs-timeout.** The machine reports "progressing / stuck / ready /
   terminal"; *when* stuck-too-long means give up is the **consumer's** patience.
5. **State→signal mappings in ONE file, fixtured, canaried** — drift breaks loudly (a fixture),
   and an unrecognized signal → UNKNOWN (graceful), never a silent misclassify.
6. **Boot reliability = hook + pre-trust.** `SessionStart` as the ready signal (reliable) +
   pre-set `hasTrustDialogAccepted` removes most pane-scraping; the `isReady` regex becomes a
   fallback that must be ANSI-dim-aware (ghost-hint = empty, draft = not).

## Boot — ranked gaps, what to keep, the fix set (from the enumeration)

**Today's boot = one brittle regex + one blind 60s timer.** `bootSession` (boot.ts:83) polls:
match a known dialog (exact-substring table, claude.ts:35) → else `isReady` (`/^❯\s*$/`,
claude.ts:90) + stabilize → else sleep. No generic-modal fallback, no progress-vs-stuck axis.

**Ranked gaps (likelihood × severity):**
1. **Ghost-placeholder ready `❯ Try "…"` → ReplTimeout (confirmed on-box, all 3 boots).**
   `/^❯\s*$/` can't match a non-whitespace placeholder. The in-file comment (claude.ts:83) even
   describes this rendering while the regex below rejects it. Also silently breaks `state()`/
   `wait()` idle (rules.idle = isReady). **#1.**
2. **Unrecognized/renamed dialog → 60s wedge (FM-21).** Closed exact-string table; any version
   bump risks a boot outage at an answerable prompt. Posse already paid for this.
3. **Resume-bridge silent send-loss.** No bridge-quiet wait despite supporting `--resume`; the
   first kickoff after resume can vanish — SILENT, worse than a timeout.
4. **Blind timeout can't tell slow-boot from wedged.** Shared 60s, no progress signal → false
   ReplTimeout on slow/parallel boxes AND 60s hangs on recoverable modals.
5. Animated footer / MCP-retry churn defeats stabilize → intermittent ReplTimeout.
6. Stale-scrollback false-match (bottom-N includes 2000-line history) → spurious DialogStuck or a
   stray Enter into the live REPL.
7. Auth-state-drift copy (token expiry) misses the single login string → timeout, not LoginRequired.

**KEEP (genuinely good — do not regress):** footer-below bottom-N scan (claude.ts:74); the
stabilize gate (boot.ts:114); gated-trust throw-BEFORE-keystroke (boot.ts:200); the
`AgentExitedDuringBoot` liveness branch (boot.ts:156); the two independent ❯-1 fail-open defenses
(dialog-first + whitespace-only).

**Fix set (replaces "one regex + one blind timer" with a progress-aware, typed model):**
- **R1 — fix `isReady` (ANSI-dim-aware).** `❯` + (only-whitespace OR a *dimmed* placeholder) is
  empty; a real one-word draft is normal-color → not idle. Use `capture-pane -pe` for the ready
  check to read the dim attribute. Independently fixturable; highest ROI.
- **R2 — typed boot outcomes**, not one opaque `ReplTimeout`: `ready` · `wedged-on-unknown-modal`
  (recoverable) · `stalled` (frozen) · `slow-progress` (still rendering at budget) · existing
  `LoginRequired`/`WorkspaceUntrusted`/`AgentExitedDuringBoot`/`DialogStuck`.
- **R3 — progress-vs-stuck**: track `lastChangeAt` (we already capture every 150ms); pane changing
  ⇒ progressing (extend/label `slow-progress`); pane frozen >5–8s with no dialog/ready ⇒ fail fast
  `stalled`/`wedged` instead of burning 60s.
- **R4 — generic-modal net (FM-21), but FAIL-CLOSED.** Detect a modal *shape* (`❯ N.` / `[y/n]` /
  `Press Enter to continue`) gated on pane-stability; but for claudemux's authority stance, an
  *unknown* modal under `trustWorkspace:false` should surface `wedged-on-unknown-modal` (typed) for
  the consumer/human, NOT blind-Enter (more conservative than Posse's auto-Enter). Never fire on
  the idle box.
- **R5 — `SessionStart` hook as boot ground-truth.** Race the pane-scrape against the SessionStart
  rendezvous marker (plumbing exists). It fires when the REPL is genuinely initialized — collapses
  the ghost-placeholder/premature-flash/ready ambiguity into a deterministic edge; pane-scrape
  becomes the fallback for pre-hook claude.
- **R6 — pre-trust** via `hasTrustDialogAccepted(cwd)` so boot never sees the trust modal (one-time
  explicit grant); keep the gated in-band throw as fallback.
- **R7 — resume-aware boot**: on resume flags, after stable-ready add a bridge-quiet wait (poll
  transcript mtime until quiet ~2s, bounded ~15s); flag `resumed:true` so consumers expect the
  history re-print.
- **R8 — bound the ready/dialog check to the live region**, not 2000-line scrollback (kills
  stale-scrollback false-matches).

## VERIFIED: boot readiness should be the SessionStart hook, not pane-scraping

Founder pushback: "isReady observes the screen — is that right? no jsonl or hooks?"

Empirically settled (2026-06-04, isolated socket, 3/3):
- **jsonl is unavailable for readiness** — interactive claude writes no transcript until the
  first user input (the consult-deadlock). So there is no jsonl ready signal. Closed door.
- **`SessionStart` is a reliable "ready for input" edge.** Sending IMMEDIATELY after the
  SessionStart marker (no isReady, no settle) landed the turn every run — `UserPromptSubmit`
  fired ~0.3–0.45s later, then `Stop`. No premature-edge loss.

**Decision: R5 is promoted from enhancement to the PRIMARY ready mechanism.**
- Boot ready = the `SessionStart` rendezvous marker appearing. `isReady` (the `/^❯\s*$/`
  pane regex) is demoted to a FALLBACK for pre-hook claude only — and even then must be
  ANSI-dim-aware (R1) for the ghost-placeholder box.
- The pane's only remaining boot role is dismissing residual modals — and even those we
  ELIMINATE rather than scrape: pre-trust (`hasTrustDialogAccepted`), theme is one-time,
  login = throw `LoginRequired`. SessionStart fires AFTER dialogs clear, so it doubles as
  "dialogs done + REPL up."
- Net: boot readiness stops being a screen-scrape. tmux is the WRITE surface + a dialog/
  unknown-modal fallback, never the primary read for "is it ready."
