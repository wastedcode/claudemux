# 0002. Claude REPL ready-marker glyph (U+276F)

**Status:** accepted
**Date:** 2026-05-28

## Context

claudemux's `idle` classifier needs a reliable signal that a Claude Code REPL
is done and ready for the next turn. The visible cue is the `❯` arrow that
claude renders at the start of an empty input line. Two risks: the exact
codepoint must be pinned (so the matcher is correct), and the *same* glyph is
reused elsewhere in claude's UI — as the selection indicator in boot dialogs
(theme picker, login picker) — so a naive "does the pane contain `❯`?" match
would false-positive during boot.

## Decision

The ready-marker glyph is **U+276F (`❯`, HEAVY RIGHT-POINTING ANGLE QUOTATION
MARK ORNAMENT)**. The `idle` predicate in `src/agents/claude.ts` must
**qualify the match by line context** — the `❯` must sit at the start of the
bottom-most non-blank visible line and the rest of that line must look like the
empty input box — rather than matching the glyph anywhere in the pane. A daily,
non-blocking CI canary (`.github/workflows/glyph-canary.yml`) guards against
upstream claude dropping or renaming the glyph; on failure it files a tracking
issue rather than blocking PRs.

## Consequences

- The classifier is robust against the boot-dialog menu indicator using the
  same codepoint — `❯ 2. Dark mode ✔` does not read as "idle".
- A single upstream release that changes the marker is caught within one
  release cycle by the canary, before it silently breaks every consumer's
  `wait()`. The canary must stay **out of the required-checks list** (it is
  non-blocking by design).
- The canary reaches only pre-auth boot dialogs (no staged credentials), so it
  confirms the glyph at the codepoint level, not the REPL-ready *form*;
  verifying the ready-marker form end-to-end is a creds-staged follow-up.

## Evidence

Confirmed on **claude v2.1.152, Linux x86_64**: a `capture-pane -p` hex dump of
the theme-picker line showed `20 e2 9d af …`, and `e2 9d af` decodes to U+276F.
The accompanying `❯ 2. Dark mode ✔` line is the documented case of the glyph
serving as a menu-selection indicator rather than the ready marker — the direct
evidence that the `idle` predicate must be line-context-qualified.
