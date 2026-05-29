# 0005. `adopt()` reuses `SessionGone` for an absent session — no new error class

**Status:** accepted
**Date:** 2026-05-28

## Context

`adopt(opts)` is the public mirror of `create()`: it re-adopts a session that is *already live*
but was created by another process (the daemon-restart recovery path). Where `create()` asserts the
session does **not** exist and throws `SessionExists` on collision, `adopt()` asserts the session
**does** exist and must report absence somehow.

Two facts shape the error choice:

1. The substrate's absence detection already collapses cases. `backend.exists(ref)` returns `false`
   both when the named session is gone *and* when the whole backend server is down (`hasSession`
   catches the no-server case). So "the session you asked for isn't there" and "nothing is running
   at all" arrive at `adopt()` as the same signal.
2. The canonical consumer's recovery is identical regardless of *why* it's absent. On a missing
   session the daemon re-creates with `--resume <persisted agentSessionId>`; it does the same
   whether one pane died or the server rebooted. The died-vs-server-down distinction is a
   *diagnostic* concern, not control flow.

A new `SessionNotFound` class was considered to name "absent on adopt" distinctly from "gone after
we held a handle."

## Decision

`adopt()` throws the existing **`SessionGone`** when the target session does not exist (including
the whole-server-down case). No new error class is introduced.

This is symmetric with `create()`/`SessionExists`: `create` and `adopt` are the two ways to obtain a
handle, distinguished by whether the session must be *absent* or *present*, and each throws the
existing "wrong presence" error. A consumer that genuinely must disambiguate "one session died" from
"the backend is unreachable" probes `list()` (or catches `BackendUnreachable` on a subsequent op) —
it does not branch on a bespoke adopt-only error.

TOCTOU is accepted and documented: `exists()` may be `true` and the session may die before the first
op, in which case that op throws `SessionGone`/`BackendUnreachable`. The upfront `exists()` check is
a courtesy fast-fail, not a guarantee.

## Consequences

- **One fewer public error class to lock under Hyrum's law.** Every exported error is a one-way
  door; a near-synonym (`SessionNotFound` vs `SessionGone`) would be permanent surface for a
  distinction no consumer's control flow needs.
- **Only the *clean* "nothing is running" case is reported as absence.** `exists()` collapses to
  `false` solely for the `no-server` flavor; the genuinely alarming infra faults — backend binary
  missing (`spawn-failed`) and wedged/hung backend (`timeout`) — are **not** swallowed: they throw
  `BackendUnreachable`, which surfaces loudly (`BackendUnreachableKind` discrimination,
  `src/errors.ts`). So a *sick* host hangs or fails-to-spawn (loud); only a *cleanly down* server
  masquerades as `SessionGone`. The design is more fail-safe than "server down → SessionGone"
  suggests.
- **Residual risk — the recovery storm.** When `no-server` is the cause, *every* `adopt()` in a
  batch returns `SessionGone` at once, and the documented response (re-create with `--resume`) fired
  N times re-spawns N sessions against a host whose backend just died. The API has erased the one
  signal ("all gone simultaneously = a server event, not N independent deaths") that would tell the
  consumer to back off. README §adopt must therefore carry the circuit-breaker: *recovering more
  than one session and all report `SessionGone` → probe `list()`/`exists()` once for the batch
  before re-creating; a uniformly-empty result is a server-restart event, not N session deaths.*
  (Security-infra should-fix, accepted.)
- **Symmetry is the API's teaching tool.** `create→SessionExists` / `adopt→SessionGone` reads as one
  pair; a reader who knows one knows the other.

## Evidence

Verified against the code at HEAD, not assumed: `create()` throws `SessionExists` via
`formatSessionLabel(ref)` (`src/session/create.ts`); `SessionGone(sessionName: string)` already
exists in the error taxonomy (`src/errors.ts`); `exists()` collapses no-server to `false`
(`src/session/registry.ts` → `backend.exists` → `hasSession`). The reuse-don't-add-an-error choice
extends the same error-taxonomy discipline recorded in `docs/decisions/0004-tmux-op-error-mapping`.
