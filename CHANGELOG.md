# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Eight typed errors** — `SessionExists`, `DialogStuck`, `ReplTimeout`,
  `LoginRequired`, `PaneDead`, `SessionGone`, `BackendUnreachable`,
  `BackendError` — every message carries the session identifier.
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

- Permission-prompt fixture ships with `scenarios: []`. Populating the
  enumerated matchers is gated on authenticated-claude observability
  (see `research/fixtures/permission-prompt-classifier-fixture.json`).
  Until then, the classifier dispatches a permission prompt to `unknown` —
  the contractual "no predicate fired" return, which consumers must not
  treat as idle.
- Post-auth dialogs (workspace-trust, post-update banner) are anticipated
  from `claude --help`; they're matched but their advancement is verified
  at product-acceptance against authenticated claude.
- Windows-native is not supported. tmux is Unix-only; WSL is
  community-contributable, undocumented by the maintainers.

[0.0.1]: https://github.com/wastedcode/claudemux/releases/tag/v0.0.1
