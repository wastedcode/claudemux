# 0004. tmux operation error mapping (TmuxOpError)

**Status:** accepted
**Date:** 2026-05-28

## Context

When a tmux operation (`send-keys`, `capture-pane`, …) targets a session whose
process has died or whose server is gone, the failure is not uniform — and one
case is a silent trap. The classifier and the public API must distinguish "the
pane's process died but tmux still holds the pane" from "the session is gone"
from "tmux itself is unreachable", because each implies a different consumer
response. The mapping is observable public-API contract.

## Decision

`src/backends/tmux/exec.ts` exposes a **`TmuxOpError` union of `{ PaneDead,
SessionGone, TmuxUnreachable }`**, mapped as:

- **`PaneDead`** (Case A — `remain-on-exit on`, process dead but pane lingers):
  `display-message -p '#{pane_dead}'` returns `1`, or `capture-pane -p` output
  contains the `Pane is dead (signal N, …)` annotation. Crucially, `send-keys`
  returns **exit 0** against a dead pane and silently drops the keystrokes — so
  send success is *never* taken as proof the agent is alive; `#{pane_dead}` /
  the annotation is the live oracle.
- **`SessionGone`** (Case B — `remain-on-exit off`, the default; session/pane
  reaped): exit 1 with a `can't find pane:` / `can't find session:` / `can't
  find window:` substring on stderr. (`has-session`'s exit code is the clean
  signal; `display-message` is *not* — it returns success with empty output for
  a missing target.)
- **`TmuxUnreachable`**: spawn-time failure / `no server running` / connection
  refused.

## Consequences

- Consumers get a typed reason for every failure instead of guessing from an
  exit code; the silent send-keys-on-dead-pane trap cannot be mistaken for a
  successful turn.
- Cleanup is `kill -9 <pane_pid>`, which transitively kills the pane's process
  group via PTY-close `SIGHUP` for the common case (children sharing the
  controlling TTY die cleanly). `setsid`-detached descendants survive and are
  out of v0.0.1 scope.

## Evidence

Reproduced on **tmux 3.6 / Linux x86_64** by killing the pane process by exact
PID under both `remain-on-exit` settings. **Case A:** `pane_dead=1`,
`list-sessions` still reports the session, `send-keys` exits 0 (empty
stdout/stderr), `capture-pane` shows the `Pane is dead (signal 9, …)`
annotation. **Case B:** session/window/pane all removed; `send-keys`,
`capture-pane`, `has-session`, `kill-session` all exit 1 with the matching
`can't find …` stderr, while `display-message` is the odd one out (exit 0, empty
output — hence excluded as a liveness probe).
