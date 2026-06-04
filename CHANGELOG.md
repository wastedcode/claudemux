# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`wait()` owns no patience — "time is the policy's."** The library-imposed
  `DEFAULT_WAIT_TIMEOUT_MS` (5 min) and the hard-coded `STUCK_MS` (30s idle
  auto-give-up) are **removed** (read/write-split RFC §5: patience is the
  consumer's, not the library's — same class as the 5.5h-deadlock anti-pattern).
  `ReadyOpts` now exposes the consumer's two patience knobs, **both optional with
  no default**: `maxMs` (wall-clock → `budget-exceeded{reason:"max"}`) and `idleMs`
  (no-progress → `budget-exceeded{reason:"idle"}`; a working turn or a tool in
  flight never trips it). With neither supplied, `wait()` blocks until a terminal
  outcome and invents no deadline. `timeoutMs` is kept as a deprecated alias for
  `maxMs` (so existing callers compile unchanged) — **behavior change:** a bare
  `wait()` no longer times out at 5 min. The CLI (`wait`/`ask`), a *consumer*,
  keeps a 300s wall-clock default of its own and gains `--idle-ms`, so shell use
  is unaffected. Surfaced by the drift-from-vision audit (the library was owning
  patience it shouldn't).

### Added

- **`send()` now recovers a lost submit (lost-Enter retry).** If the paste reaches
  the composer but the Enter keystroke is dropped (a boot-race / timing flake), the
  turn sits un-submitted and no user record appears. `send()` previously returned
  `DELIVERY_UNCONFIRMED` immediately; it now owns the recovery — when its anchor
  fails and the message wasn't queued, it re-fires Enter once (`submitOnce`, which
  submits the existing draft and **never re-pastes**, so it can never duplicate the
  body) and re-anchors before reporting `DELIVERY_UNCONFIRMED`. This folds the
  consumer's hand-rolled "deliver-with-confirm" recovery into the substrate.
  Unit-tested deterministically (a backend that drops the first Enter). **Additive
  / non-breaking** — the contract (real cursor | `DELIVERED_QUEUED` |
  `DELIVERY_UNCONFIRMED`) is unchanged; failures are just rarer.
- **`DELIVERED_QUEUED` — send-while-busy is no longer mistaken for a lost send.**
  A message sent into a still-working session is **queued** by claude (it shows
  "Press up to edit queued messages") and runs after the in-flight turn — but its
  user record doesn't flush until then, so `send()` used to return
  `DELIVERY_UNCONFIRMED`, indistinguishable from a genuinely lost send. A consumer
  re-sending on unconfirmed would **double-run** the queued message. `send()` now
  returns the distinct exported `DELIVERED_QUEUED` sentinel when the agent reports
  its queue affordance — "accepted, will run, don't re-send." Both sentinels still
  read empty against `messagesSince`/`turnComplete` (never a whole-transcript
  slice). The agent owns the queue-affordance vocabulary (new optional
  `ClassifierRules.queued`, mirroring `interrupted`); the send path composes it.
  Verified live on claude 2.1.162. **Additive / non-breaking.** See README §4.

- **`respond(choice)` + first-class permission prompts** — claudemux now detects
  claude's mid-turn tool-approval prompt (`Do you want to <verb> <target>?` →
  `1. Yes / 2. Yes, allow all… / 3. No`). `state()` reads `permission-prompt` and
  `wait()` returns `{ kind: "awaiting", on: "permission-prompt" }` instead of
  running out its budget. Answer it with `respond(choice)` —
  `"approve"` / `"approve-for-session"` / `"deny"` (the agent owns the menu
  option-order; you never type a digit). Mechanism, not policy: it fires the
  keystroke and self-confirms the menu cleared before returning (so the natural
  `respond → wait` loop is race-free), but *whether* to approve is yours —
  claudemux never auto-answers an authority grant. New typed error
  `PromptResponseUnsupported` (an agent that declares no menu mapping). New
  public type `PromptChoice`. New CLI verb `claudemux respond <name> <choice>`.
  Detection + handling shipped as **one unit** per ADR 0010; verified verbatim
  against authenticated claude 2.1.162 (both approve and deny). **Additive /
  non-breaking** — `permission-prompt` was already a reserved `State`/`awaiting`
  member. See README §5.

### Fixed

- **Compaction-safe `messagesSince` (defense-in-depth).** Verified live that a
  compaction boundary does *not* break the transcript's `parentUuid` chain on
  claude 2.1.162 (it stays append-only, so a post-compaction turn still descends
  from a pre-compaction cursor — `messagesSince`/recall hold). `descendantsOf` now
  also classifies each message's lineage and, should a future record-format change
  ever drop an intermediate record, falls back to file position for the
  **orphaned** post-cursor tail — provably without re-including the prior turn's
  late-flushed reply (which roots cleanly and is never an orphan). No behavior
  change on current claude.
- **Denied tool no longer wedges `wait()` at `budget-exceeded`.** A tool the
  consumer *denies* fires `PreToolUse` (a `tool-start` hook edge) but never
  `PostToolUse` — so the hook-derived belief was stuck at `phase=tool`/`working`
  forever though the turn was over, and `wait()` timed out on the stuck detector.
  The fused belief now cross-checks the pane: when the hooks say `working` but the
  pane has settled to a clean idle box (which a genuinely in-flight tool never
  renders), the turn has ended. (Surfaced by the permission-prompt deny path.)

## [0.1.0] - 2026-06-02

### Added

- **`agentSessionId`** — every session now has a stable, opaque, backend-neutral
  conversation id, surfaced as `readonly agentSessionId?: string` on the handle
  (returned by `create()` and `adopt()`). `create()` mints a v4 UUID and assigns
  it to the agent at spawn (claude's `--session-id`), so you know the id **before
  the agent writes a byte** — no scraping, no race. Use it to **resume** a
  conversation (rides `extraArgs`: `create({ extraArgs: ["--resume", id] })`) and
  to **locate the transcript** (`~/.claude/projects/<cwd-slug>/<id>.jsonl`).
  `create({ agentSessionId })` lets you choose the id for a *fresh* conversation
  (v4-UUID-validated; caller-wins over an `extraArgs` identity flag; supplying
  both is a fail-fast `AgentSessionIdConflict`). A chosen id that already has a
  conversation makes the agent exit rather than silently resume → typed
  `AgentExitedDuringBoot` (the id carried on the error), fast, never a silent
  resume. The id is `undefined` — never fabricated — for older/non-claudemux,
  cache-miss-on-adopt, or bare-`--resume`/`--fork-session` sessions. New typed
  errors: `AgentExitedDuringBoot`, `InvalidAgentSessionId`, `AgentSessionIdConflict`.
  Persist `{ name, agentSessionId }` together for restart recovery. **Additive /
  non-breaking** — the field is optional (optional→required later stays
  non-breaking). See README §"Session identity".
- **`interrupt()`** — stop a working agent. Fires a single ESC (claude's own
  interrupt key) at the session through the per-handle mutex, same as
  `send`/`wait`. Mechanism, not policy: ESC is sent **regardless of state** and
  is meaningful only when the agent is `working`; on an idle claude it harmlessly
  clears the input box, so the substrate does not guard on state. The verb does
  exactly one thing (stop the turn) and bundles no follow-up. **Additive /
  non-breaking.** Note: after `interrupt()`, `state()` reads `unknown` (claude
  restores the interrupted message into the composer), so do **not**
  `wait()`-for-idle or naively `send()` a replacement — see README
  §"Interrupting a working agent" for the clean interrupt-and-replace recipe
  (clear the restored composer to empty, then `send`) and the slow-abort caveat.
  Mirrored on the CLI as `claudemux interrupt <name>`.
- **`adopt()`** — the public mirror of `create()`: re-attach to a session that
  is already live but was started by another process (the daemon/process-restart
  recovery path). Pure attach — asserts the session exists, returns a handle; no
  spawn, no boot, no dialog dismissal. Throws `SessionGone` when the session is
  absent (including a cleanly-down backend), symmetric with `create()`'s
  `SessionExists`. **Additive / non-breaking** — no existing API changes. See
  README §"Re-adopting a live session after a restart" for the A/B/C recovery
  taxonomy, the persist-both / single-writer / trust-dialog contracts, and
  `examples/adopt-after-restart.ts` for the runnable recovery loop.

### Changed

- **`PaneDead.signal` is now the canonical signal name** (e.g. `"SIGKILL"`),
  typed `string | undefined`, replacing the previous `number`. Signal numbers
  are not stable across operating systems; names are, and stay backend-neutral.
  Breaking vs v0.0.1, taken now pre-adoption. See ADR 0007.

### Fixed

- **`PaneDead` now fires on macOS.** tmux renders the dead-pane cause as a signal
  *name* there (`Pane is dead (signal kill, …)`) but a *number* on Linux; the
  detector required a number, so a dead pane read as alive on macOS. Detection
  now anchors on the `Pane is dead (` annotation prefix, independent of how the
  cause renders (`signal 9` / `signal kill` / `status N`) — no false negatives.
  Pinned with pure unit fixtures for every rendering. See ADR 0007.

## [0.0.1] - 2026-05-28

### Added

- **Eight-verb substrate surface** for Claude Code sessions, library and CLI 1:1:
  `create`/`spawn`, `send`, `wait`, `state`, `capture`, `kill`, `exists`, `list`.
- **Boot orchestrator** that dismisses the theme-picker dialog on a fresh
  `~/.claude/` and surfaces `LoginRequired` cleanly when claude is not
  authenticated. The substrate never auto-answers the login dialog.
- **State classifier** with five values — `working`, `idle`, `permission-prompt`,
  `dialog`, `unknown`. Scans only the bottom-N pane lines so scrollback
  false-positives are impossible by construction.
- **Ten typed errors** — `SessionExists`, `DialogStuck`, `ReplTimeout`,
  `LoginRequired`, `WorkspaceUntrusted`, `PaneDead`, `SessionGone`,
  `BackendUnreachable`, `InvalidSessionName`, `BackendError` — each extends
  `ClaudemuxError` with an actionable, backend-neutral message (the backend's
  vocabulary never leaks into a public error; grep-enforced in CI).
- **Per-session mutex** on `send`/`wait`/`state`/`capture`/`kill`. Concurrent
  consumer calls cannot interleave bytes.
- **`onBackendCommand`** — the single observability primitive: one event per
  backend call with argv, duration, exit code, and streams.
- **Backend-neutral public API**. The current backend is tmux; future
  backends (node-pty, `CustomPaneBackend`, etc.) slot in without consumer
  rewrites. Layering is grep-enforced in CI.
- **CLI** `claudemux` with the eight verbs above. `--help` is backend-neutral
  by construction (grep-test in CI).
- **Multi-line paste** via the backend's safe paste mechanism. The `Backend`
  interface has no `sendRawText` primitive — multi-line input cannot leak
  around the seam.
- **Idempotent kill / list / exists** — kill of a missing session is
  success; list against an empty server returns `[]`.

### Notes

- **Permission-prompt detection and handling are deferred to v0.1** (per
  ADR 0010). `permission-prompt` is a reserved member of the public `State`
  type that v0.0.1 does not emit: a tool-approval prompt classifies as
  `unknown` (never `idle`), so an interactive `default`-mode session that hits
  one elapses to `ReplTimeout`. Run unattended sessions in a non-interactive
  permission mode — see README §5. The enumerated prompt shapes are kept in
  `test/fixtures/` (not shipped) as the v0.1 starting point.
- Post-auth dialogs (workspace-trust, post-update banner) are anticipated
  from `claude --help`; they're matched but their advancement is verified
  at product-acceptance against authenticated claude.
- Windows-native is not supported. tmux is Unix-only; WSL is
  community-contributable, undocumented by the maintainers.

[Unreleased]: https://github.com/wastedcode/claudemux/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wastedcode/claudemux/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/wastedcode/claudemux/releases/tag/v0.0.1
