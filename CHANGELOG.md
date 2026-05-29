# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`adopt()`** — the public mirror of `create()`: re-attach to a session that
  is already live but was started by another process (the daemon/process-restart
  recovery path). Pure attach — asserts the session exists, returns a handle; no
  spawn, no boot, no dialog dismissal. Throws `SessionGone` when the session is
  absent (including a cleanly-down backend), symmetric with `create()`'s
  `SessionExists`. **Additive / non-breaking** — no existing API changes. See
  README §"Re-adopting a live session after a restart" for the A/B/C recovery
  taxonomy, the persist-both / single-writer / trust-dialog contracts, and
  `examples/adopt-after-restart.ts` for the runnable recovery loop.

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

[0.0.1]: https://github.com/wastedcode/claudemux/releases/tag/v0.0.1
