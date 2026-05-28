# 0001. tmux paste mechanism for multi-line input

**Status:** accepted
**Date:** 2026-05-28

## Context

claudemux delivers a user turn to a Claude Code REPL running inside a tmux pane.
A turn can be multi-line, and the delivery mechanism must satisfy two
properties: the body must arrive at the receiver **byte-for-byte** (tabs,
backslashes, multi-byte unicode intact), and a multi-line body must register as
**one logical turn**, not one submit per line. tmux offers several ways to put
text into a pane — `send-keys` per line (submits each line), `load-buffer +
paste-buffer` with or without `-p`, or hand-rolled bracketed-paste escapes via
`send-keys -H`.

## Decision

`src/backends/tmux/keys.ts` uses **`load-buffer + paste-buffer -p`** as the
primary multi-line paste mechanism. `-p` lets tmux wrap the payload in
bracketed-paste sequences when the receiver advertises support, which is how a
TUI agent distinguishes a *pasted* `\n` (literal newline in the body) from a
*typed* `\n` (submit). All body line terminators are **normalized to `\n`**
before the paste. **Submission is a separate `send-keys Enter` after the paste,
never folded into the paste body** — there is deliberately no `sendRawText`
seam, so multi-line input cannot leak around the paste/submit boundary.

## Consequences

- Multi-line turns are delivered as a single paste followed by one explicit
  submit; the per-line-submit failure mode is structurally impossible.
- The receiver-side question — does authenticated claude actually treat a
  pasted body `\n` as a literal newline rather than a submit? — is *not* proven
  here (see Evidence) and was deferred to the substrate build's first
  acceptance pass against authenticated claude. If that probe finds the
  convention does not hold (claude submits on a body `\n`), the body must escape
  `\n` (or use `\r` exclusively) and this decision is revised before relying on
  it in anger.

## Evidence

Verified byte-perfect end-to-end on **tmux 3.6 / Linux x86_64** against a
passive sink (`cat > file`): a mixed-content payload (tabs, backslashes, a
4-byte emoji, RTL Arabic) round-tripped `cmp`-equal. `paste-buffer` does not
transform line terminators — `\n`, `\r`, `\r\n` arrive as exactly those bytes.
The normalize-to-`\n` + separate-Enter shape matches the documented convention
of every TUI agent that opts into bracketed paste. **Coverage gap:** the
*delivery* side is proven; the *receiver-interpretation* side (does claude see
one logical turn?) requires authenticated claude in a TTY, which the research
sandbox did not provide, and is named pending for substrate acceptance.

### Alternatives rejected

- **`send-keys "line" Enter` per line** — each Enter submits the partial turn;
  wrong for a multi-line turn.
- **`paste-buffer` without `-p`** — delivers bytes correctly but drops the
  bracketing, so the receiver cannot distinguish pasted from typed newlines.
- **Hand-rolled `send-keys -H` with explicit `ESC[200~`/`ESC[201~`** — works but
  depends on getting the byte sequence right by hand; `-p` lets tmux own it.
