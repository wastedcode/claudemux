# 0007. `PaneDead` detection anchors on the annotation prefix; the signal is a canonical name, not a number

**Status:** accepted
**Date:** 2026-06-03

## Context

`PaneDead` is the public typed error surfaced when a pane's process has died but
the pane container lingers (Case A, `remain-on-exit on` — see the
`tmux-pane-death-detection` wiki). The backend detects it by scanning
`capture-pane` stdout for tmux's `Pane is dead (…)` annotation.

The v0.0.1 detector required the cause to be a **number**:

```ts
stdout.match(/Pane is dead \(signal (\d+),/)   // → PaneDead.signal: number
```

The macOS CI matrix (tmux 3.2a/3.4/3.5a) surfaced that this is a false negative
on macOS: tmux there renders the cause as a signal **name** —
`Pane is dead (signal kill, …)` — not a number. `(\d+)` never matches `kill`, so
`detectPaneDeadAnnotation` returned `null`, `PaneDead` never fired, and a dead
pane read as alive on a platform the project treats as non-negotiable
([[../../brain/decisions/0008-v0-0-1-quality-bar]]).

Two design smells underlay the bug:

1. **Detection was coupled to cause-parsing.** The function returned
   `number | null`, where `null` meant *both* "not dead" *and* "dead but I
   couldn't parse the signal." Any unparseable cause read as alive.
2. **The signal was represented as a number.** Signal *numbers* are not stable
   across operating systems (`SIGUSR1` is 10 on Linux, 30 on macOS), so a raw
   number is not the backend-neutral identity the public surface promises. The
   raw token (`9` vs `kill`) is worse still — it leaks the platform's rendering
   straight into a backend-neutral error.

## Decision

1. **Detection anchors only on the stable `Pane is dead (` line prefix**, never
   on parsing the cause. A dead pane throws `PaneDead` whether the cause renders
   as `signal 9`, `signal kill`, or `status N` (normal exit). The cause is
   parsed best-effort *after* the death is already established. This removes the
   `null`-conflation and the whole class of false negatives.

2. **The signal is represented as a canonical name** (`"SIGKILL"`), normalized in
   the backend via Node's `os.constants.signals` (number→name and name→name, no
   hand-maintained table). Names are the platform-stable, backend-neutral
   identity. `PaneDead.signal` is `string | undefined` — undefined for a normal
   exit or an unrecognized token; the error still fires.

3. **The parser is pinned with pure unit fixtures** for every real annotation
   rendering — `signal 9` (Linux), `signal kill` (macOS), `signal TERM`,
   `status 0` (exit), plus a mid-line false-positive guard. The platform bug is
   now caught on any runner, not only under the macOS matrix.

## Consequences

- **Breaking vs v0.0.1:** `PaneDead.signal` changes from `number` to
  `string | undefined`. Taken deliberately at 0.1.0, days after v0.0.1 and
  before adoption — API shape is cheapest to correct now. The non-breaking
  alternative (normalize the name to a number) just defers the platform-number
  problem to the first consumer who branches on a non-portable signal number.
- **macOS `PaneDead` works**, closing the matrix failure without weakening the
  trip-wire: detection is strictly broader (prefix-anchored), never narrower.
- **`detectPaneDeadAnnotation` now returns `PaneDeadInfo | null`** (presence =
  dead), so callers can no longer confuse "not dead" with "dead, signal
  unknown."
- The `tmux-pane-death-detection` wiki's `signal: number` / `(\d+)` references
  are updated to point here.

## Alternatives considered

- **Report the raw tmux token (`number | string`).** Rejected: leaks the
  backend's *and* the platform's rendering into a backend-neutral public error,
  violating the no-backend-leak invariant the repo grep-enforces.
- **Normalize to a number (non-breaking).** Rejected: signal numbers aren't
  cross-platform stable, so it re-creates the same class of bug a layer down,
  and ossifies a wrong shape right before adoption.
- **Detect via `#{pane_dead}` instead of the annotation.** Out of scope here —
  it's the other Case-A oracle (wiki), used by the liveness pre-check, not by
  `capturePane`. This ADR only hardens the annotation path `capturePane` already
  owns.
