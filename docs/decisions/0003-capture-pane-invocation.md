# 0003. capture-pane invocation for the classifier snapshot

**Status:** accepted
**Date:** 2026-05-28

## Context

The classifier reads the bottom N lines of a pane to decide a session's state.
Two questions had to be settled before `src/backends/tmux/capture.ts` could be
written: (1) which `capture-pane` invocation yields the live-visible bottom-N,
and (2) whether that invocation stays correct when the founder has attached a
client and scrolled the pane into copy-mode mid-flight (a v0.0.1 acceptance
criterion: "attaching/detaching does not corrupt state").

## Decision

`capture.ts` uses **`tmux -L <socket> capture-pane -p -t <target>`** for the
live-visible snapshot, then takes the bottom-N **in code** via
`output.split('\n').slice(-N)`. It does **not** use `capture-pane -S -N`. No
copy-mode-aware fallback (no `send-keys -X cancel`, no alternate invocation) is
needed: the default invocation already returns the live tail regardless of
copy-mode or client attachment. (`-e` to preserve ANSI is added only when a
caller explicitly asks; the classifier matches against plain text.)

## Consequences

- Bottom-N slicing is a pure, testable string operation independent of tmux
  flag quirks.
- The founder can attach and scroll back freely; the classifier keeps seeing
  the live tail, so the "attach/detach does not corrupt state" acceptance
  criterion holds as written, with no intrusive viewport reset.

## Evidence

On **tmux 3.6 / Linux x86_64**: `capture-pane -p` always returned exactly the
`pane_height` live-visible rows. `-S -N` was measured to return `N +
pane_height` lines (e.g. `-S -10` on a 24-row pane returned 34 lines starting
10 rows into history) — it captures *from N lines into history through the
bottom*, not the bottom-N. For copy-mode: with a real client attached via
`script(1)`, driven into copy-mode and scrolled back 3 pages while an emitter
kept producing, `capture-pane -p` returned the live tail (`emit-71..74`) while
the attached client's screen showed `emit-25..49`. This follows from tmux's
data model — the pane buffer is the source of truth and `capture-pane` walks
the live grid, while copy-mode is only a per-client viewport overlay.

### Alternatives rejected

- **`capture-pane -S -N`** — the plan assumed this meant "visible bottom-N"; it
  does not. It returns `N + pane_height` lines, so it would over-capture into
  history and misalign the classifier window.
- **`send-keys -X cancel` before capture** — unnecessary (copy-mode does not
  affect the default capture) and intrusive (it would undo the founder's
  scroll).
