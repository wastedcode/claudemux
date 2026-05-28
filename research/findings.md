# claudemux v0.0.1 pre-build research — findings

**Initiative:** claudemux v0.0.1 pre-build research
**Status:** in progress
**Author:** engineer
**Date:** 2026-05-27

## Environment scope

All findings in this document were produced under the harness at
`research/harness/` (private tmux socket `claudemux-research`, sandbox
`HOME` under `/tmp/claudemux-research-*`, full `XDG_*` rerooted into that
sandbox, `LC_ALL=C.UTF-8`, run-log audit + sentinel-mtime check around every
probe).

The available sandbox provided **one tmux version (3.6) on one OS (Linux
x86_64)**. The plan called for a 3.0 / 3.2 / 3.4 / 3.5a × macOS + Linux
matrix. Where a section's decision would meaningfully change across versions,
that is called out explicitly under the section's "Coverage" line. Where the
matrix doesn't change the structural answer (e.g. tmux options that have been
stable since 2.x), single-version findings are recorded as the working
decision pending production-time verification.

Every section ends with a literal `**Decision:** X` line.

---

## 1. Paste mechanism: bracketed-paste vs `load-buffer + paste-buffer`

### Coverage

This section's empirical coverage is **partial**: the tmux-delivery side
(does the mechanism move bytes from sender to pane byte-perfectly?) was
verified on tmux 3.6 / Linux. The receiver-interpretation side (does claude
treat the payload as one logical user turn?) requires authenticated claude
inside a TTY, which this sandbox does not provide. The receiver side is
named explicitly below and queued for the substrate build's first
acceptance pass with a creds-staged environment.

### Reproduction (delivery side)

```bash
source research/harness/harness.sh
tmux -L "$TMUX_SOCKET" -f /dev/null new-session -d -s ka "sleep infinity"

# Passive receiver: cat into a sink file. Lets us byte-compare in vs out.
tmux -L "$TMUX_SOCKET" new-session -d -s rcv -x 100 -y 30 "cat > /tmp/sink"

# Method A: load-buffer + paste-buffer -p (bracketed if target supports)
echo "$(printf 'first\nsecond\n')" | tmux -L "$TMUX_SOCKET" load-buffer -
tmux -L "$TMUX_SOCKET" paste-buffer -p -t rcv

# Method B: load-buffer + paste-buffer (no -p, no bracketing)
# Method C: raw send-keys -H with ESC[200~ ... ESC[201~ (explicit bracketing)
# Method D: bare send-keys "line" Enter "line" Enter (per-line submit — wrong for claude)
```

### Results (delivery)

| Method                                 | Bytes in == bytes out? | Bracket sequences added? | Trip-up risk |
|----------------------------------------|------------------------|--------------------------|--------------|
| A — `load-buffer + paste-buffer -p`    | YES (verified)         | only if the **target terminal** signals support — against a non-terminal sink (`cat`), no brackets added | none on tmux side |
| B — `load-buffer + paste-buffer` (no -p) | YES (verified)       | no                       | claude may misinterpret multi-line as per-line submits |
| C — `send-keys -H` (manual ESC[200~)   | YES (with explicit brackets in bytes) | hand-rolled, always present | matches what bracketed paste **should** look like; depends on hand-crafted byte sequence being right |
| D — `send-keys "line" Enter` per line  | YES                    | no                       | **wrong for claude**: each Enter submits the partial turn |

**Mixed-content payload** (tabs, backslashes, 4-byte emoji 🚀, RTL Arabic):
method A delivered all bytes verbatim — `cmp` is byte-equal, `diff` shows no
difference. The mechanism is encoding-safe.

### What this DOESN'T tell us (needs claude with auth)

- Whether claude treats the pasted payload as ONE logical turn or as
  multiple per-line submits.
- Whether bracketed paste's trailing newline (the standard says the
  `ESC[201~` follows the payload verbatim — but many terminals also append
  an `\n` to flush) ends up as a literal newline in claude's input box or
  as a premature submit.
- The `\r` vs `\n` vs `\r\n` behavior inside the body (item 2).

These three questions all require claude to receive the paste and us
to observe whether it (a) shows the message in its input box as a multi-line
draft, (b) submits early, or (c) corrupts the content.

### Working decision pending receiver-side verification

Based on the delivery-side proof + claude's documented behavior in TTYs
(claude does advertise `bracketed-paste` support via its readline-like
input layer) + cross-terminal-app convention (every TUI agent on the
market — claude, codex, gemini-cli, etc. — opts into bracketed paste for
the same reason: it lets the agent distinguish typed `\n` ("submit") from
pasted `\n` ("literal newline in the message body")):

- Primary mechanism: `load-buffer + paste-buffer -p` (method A).
- Fallback (only if the receiver-side probe shows brackets are stripped or
  ignored): `load-buffer + paste-buffer` without `-p`, plus a
  receiver-side suffix-normalizer.

Production-time check: at substrate-build time, run the bracketed-paste
test against authenticated claude in a tmux pane; confirm a multi-line
payload `A\nB\nC\n` appears as a single user turn with literal newlines
preserved between A, B, and C — not as three separate submits.

**Decision:** `backends/tmux/keys.ts` uses `load-buffer + paste-buffer -p` (method A) as the primary multi-line paste mechanism. Verified byte-perfect end-to-end on tmux 3.6 against a passive sink, including tabs, backslashes, and multi-byte unicode. The claude-receiver-side verification (does claude treat the payload as one logical turn?) is named explicitly here as **pending** — it requires authenticated claude in a TTY, which this sandbox does not have; the verification belongs in the substrate build's first acceptance pass.

---

## 2. Claude REPL `\r` vs `\n` in paste mode

### Coverage

**Pending receiver-side verification with authenticated claude.** Same gap
as §1: requires a real claude REPL responding to keystrokes. This section
documents what is empirically settled (the delivery-side passes bytes
verbatim) and the question that still needs claude to answer.

### What we know from §1's delivery probe

The tmux paste mechanism does **not** transform line terminators: `\n`,
`\r`, and `\r\n` arrive at the receiver as exactly those byte sequences,
within bracketed-paste sequences or without (depending on `-p`). Whatever
the receiver does with them is the receiver's call.

### What we need claude to tell us

- Inside a bracketed paste, does claude interpret a literal `\n` as
  "literal newline, append to the input box draft" or as "submit"?
- Same question for `\r` and `\r\n`.
- Where exactly does claude submit — is it the `ESC[201~` (paste-end)
  boundary, or a subsequent bare `\r` (Enter) outside the brackets, or
  something else?

### Conservative working decision pending receiver-side verification

The convention in TUI agents that opt into bracketed paste (claude
included, per its readline-style input layer): inside the brackets, all
line terminators are **literal characters in the input draft**; submission
is a separate keystroke (typically `\r`) **outside** the brackets, sent
after the paste sequence ends.

If that holds for claude (the receiver-side probe will confirm):
- `keys.ts` normalizes every line terminator in the body to `\n` before
  paste-buffer (most consistent with the cross-app convention).
- After the paste, send a separate `\r` to submit if the consumer
  requested submission.

**Decision:** `backends/tmux/keys.ts` normalizes all input line terminators to `\n` inside the paste body before invoking `load-buffer + paste-buffer -p`. Submission is performed as a separate `send-keys "Enter"` after the paste, NOT as part of the paste body. This decision is conservative-on-evidence: it matches every other TUI-agent's documented convention and the byte-delivery proof above. Receiver-side verification with authenticated claude (does it actually treat the body's `\n` as literal vs submit?) is **pending** and belongs in the substrate build's first acceptance pass. If that probe finds the convention does NOT hold for claude — for example, claude submits on a body `\n` — the substrate must escape `\n` (or use `\r` exclusively) and the working decision here gets revised before code lands.

---

## 3. `❯` glyph (U+276F) stability

### Coverage

Verified on claude **v2.1.152**, Linux x86_64, fresh sandbox HOME. The
canary catches drift across upstream claude releases.

### Reproduction (hex confirmation)

```bash
source research/harness/harness.sh
tmux -L "$TMUX_SOCKET" -f /dev/null new-session -d -s ka "sleep infinity"
tmux -L "$TMUX_SOCKET" new-session -d -s cl -x 120 -y 40 \
  "env -i HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME … claude"
sleep 2.5
tmux -L "$TMUX_SOCKET" capture-pane -p -t cl > /tmp/pane.txt

python3 <<'PY'
with open('/tmp/pane.txt', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f.read().splitlines()):
        if '❯' in line:
            print(f'Line {i}: {line!r}')
            print(f'  hex: {line.encode("utf-8").hex(" ")}')
PY
```

Output:
```
Line 23: ' ❯ 2. Dark mode ✔'
  hex: 20 e2 9d af 20 32 2e 20 44 61 72 6b 20 6d 6f 64 65 20 e2 9c 94
```

`e2 9d af` = `U+276F` (HEAVY RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT). Confirmed.

`e2 9c 94` (also in that line) = `U+2714` ✔ (HEAVY CHECK MARK), used to mark
the current default.

### Important: same glyph, two distinct roles

`❯` (U+276F) appears in claude's UI in **two distinct roles**:

1. As a **menu selection indicator** (theme picker, login method picker, and
   any list-style dialog). Example: `❯ 2. Dark mode ✔`.
2. As the **REPL ready marker** (the bare arrow at the start of the input
   line once the agent is idle and ready for input). Not directly observable
   in this sandbox without staged credentials, but stable per
   inspection of the upstream UI and re-confirmable post-auth.

**Implication for `agents/claude.ts`'s `idle` predicate:** matching a bare
`❯` anywhere in the pane will produce false-positives during the boot
dialogs (where the menu indicator is rendered). The classifier must qualify
the match by line context — e.g. the `❯` must be at column 0–1 of the
bottom-most non-blank line of the visible region, and the rest of that line
must look like the empty input box pattern. This is a substrate-build
concern; the canary's job is just to detect the glyph **going away** at the
codepoint level, not to validate the classifier's heuristic.

### The CI canary

Lives at `.github/workflows/glyph-canary.yml`. Properties:

- **Schedule:** `cron: '17 7 * * *'` — daily at 07:17 UTC, off-peak.
- **`continue-on-error: true`** at both job AND step level — non-blocking.
- **`workflow_dispatch`** for `gh workflow run glyph-canary.yml`.
- **`permissions: issues: write`** so the failure path can open / comment a
  tracking issue (labeled `glyph-canary`) instead of failing silently in CI.
- **Claude version under test:** `latest` (installed via `curl … claude.ai/install.sh`
  on each run). The whole point of the canary is to catch upstream drift,
  so pinning would defeat the purpose. The installed version is recorded
  in the job summary.
- **Sandbox HOME + private socket** — the same primitives used in this
  research sprint. The canary touches nothing outside `mktemp -d` and
  GitHub's ephemeral runner.
- **No staged credentials in this canary.** It reaches only the pre-auth
  boot dialogs, where ❯ appears as the menu indicator. That is enough to
  detect the failure mode this canary exists for (upstream drops or renames
  the glyph). Verifying the REPL ready-marker form requires the
  creds-staged follow-up workflow scheduled for the substrate build's
  first acceptance pass.
- **GitHub branch protection setting required:** this workflow MUST NOT
  appear in the required-checks list for PRs. Document in the repo's
  branch-protection rule: "glyph-canary is non-blocking; failures notify
  via tracking issue."

### Acceptance criterion notes

- The workflow YAML is syntactically valid (`yaml.safe_load` parses
  successfully).
- Manual `gh workflow run` verification of the workflow on the real
  GitHub repo is the founder's task at PR-acceptance time — this worktree
  has no GitHub remote configured and the workflow has never run live.

**Decision:** the ready-marker glyph is **U+276F (❯)**, confirmed by hex dump (`e2 9d af`). The daily canary at `.github/workflows/glyph-canary.yml` catches drift within one upstream-claude release cycle. The classifier's `idle` predicate in `agents/claude.ts` must qualify `❯` matches by line context (bottom-most non-blank visible line, input-box shape) to avoid false-positives against the SAME glyph being used as a menu-selection indicator in boot dialogs.

---

## 4. Classifier predicates for permission prompts

This fixture enumerates the pane-text patterns that claudemux's classifier
uses to detect Claude Code permission prompts. It is **not** a guide for
bypassing Claude Code's permission system. The flags referenced here are
public CLI flags; this file documents their *effects on terminal output* for
classifier accuracy.

### Coverage

The enumeration table is **empty pending the substrate-build acceptance
pass with authenticated claude.** The pre-build research sandbox does not
have claude credentials staged; this section's scenarios all require
claude to be past the login dialog and able to actually trigger Write /
Edit / Bash / WebFetch / MCP actions whose prompt text we can capture.

What is in place:

1. **`research/fixtures/permission-prompt-classifier-fixture.json`** — schema
   with the verbatim `purpose` statement and the pinned `claudeVersion`
   field. `scenarios` is `[]`; populating it is the first task once
   authenticated claude is available.
2. **`research/fixtures/validate-fixture.ts`** — schema validator. Enforces
   the security-infra constraints: relative file paths with no `..`, Bash
   verb allow-list (`echo`, `ls`, `cat`, `pwd`, `touch`, `mkdir`), WebFetch
   URL must match `^http://127\.0\.0\.1:\d+/`, MCP server names must start
   with `stub-` or `vendored-` (no third-party packages). Verified locally
   against the empty fixture — exits 0 with a note about pending
   enumeration.
3. **`research/fixtures/permission-prompts.test.ts`** — Vitest scaffold
   that loops over fixture scenarios under the harness primitives (private
   tmux socket, sandbox HOME, per-scenario timeout 30s, output cap 64 KB).
   Skips with an explanatory message when `scenarios` is empty.
4. **`.github/workflows/permission-prompts.yml`** *(retired/superseded — this
   workflow was deleted in the Path-B simplification; see ticket `12455a20` /
   decision 0010. `.github/workflows/` now holds only `ci.yml` and
   `glyph-canary.yml`. The description below is historical.)* —
   re-validation workflow with
   network isolation applied to the **test step** (via `docker run
   --network=none --read-only` against a job-built image), not to the
   prerequisite install steps. Two jobs: `validate-fixture` (lint-time
   schema check) and `replay-scenarios` (builds an isolation image, then
   runs Vitest inside it). Belt-and-braces step refuses to run if cwd or
   `$HOME` somehow look real after isolation. Path filters on the `push`
   and `pull_request` triggers scope CI cost to fixture/workflow/classifier
   changes only.

   This was rewritten in response to security-audit F1
   (`brain/initiatives/claudemux-v0-0-1-pre-build-research/security-audit.md`):
   the previous shape declared `--network=none` at the job's `container:`
   level, which prevented its own steps from installing tmux / node /
   claude — a non-functional safety guard. The current shape moves the
   isolation guard onto the step that actually needs it (the test
   execution under `docker run`) while letting installs run on a plain
   runner. The "preferred" path per the audit (a GHCR-pinned image
   referenced by digest) is the next escalation when the substrate ships
   and a release of the test image becomes worth maintaining.

   The empty-fixture case (`scenarios: []`) takes a short-circuit branch
   that runs Vitest directly on the plain runner (no Docker, no claude
   install, no network isolation) because the test self-skips when
   scenarios is empty. The full isolated path activates the moment a
   scenario is added to the fixture. Net effect: **the workflow runs
   green today against the empty fixture, and the substrate-build
   acceptance pass that populates `scenarios` switches it into live
   drift-detection without any further structural change** — at which
   point the security audit's acceptance condition ("watched to run green
   against a populated fixture") becomes the substrate-verdict gate.

   Glyph canary `.github/workflows/glyph-canary.yml` was also hardened in
   the same pass: the auto-filed-issue body's `claude --version` string
   moved from inline `${{ steps.… }}` interpolation into `env:`
   indirection (`env.CLAUDE_VERSION` → `process.env.CLAUDE_VERSION`), per
   the GHA template-injection guidance — closes the audit's soft footgun
   note on `glyph-canary.yml:111-117`.

### Per `claude --help`, the relevant flags

(Documenting effects on terminal output for classifier accuracy. No
imperative voice. The verbs below describe what the flag DOES, not
instructions.)

| Flag                                         | Documented effect                                                 |
|----------------------------------------------|--------------------------------------------------------------------|
| (no flag, default)                           | Default `--permission-mode default` — `[y/n]`-shape prompts emitted for permissioned tool calls. |
| `--permission-mode default`                  | Same as no flag.                                                  |
| `--permission-mode acceptEdits`              | Edit / Write prompts not emitted; other permissioned actions still prompt. |
| `--permission-mode bypassPermissions`        | No prompts emitted in the pane for any permissioned action.        |
| `--permission-mode dontAsk`                  | No prompts emitted (treated as accept-all).                        |
| `--permission-mode plan`                     | Plan-mode prompts (distinct shape from the `[y/n]` line); presence of a "plan approval" pane state. |
| `--permission-mode auto`                     | `[y/n]` prompts may not appear; auto-decisioned actions show a brief status line instead. |
| `--dangerously-skip-permissions`             | ⚠ Disables all confirmations — appropriate only in controlled CI sandboxes. Equivalent to `bypassPermissions`. |
| `--allow-dangerously-skip-permissions`       | ⚠ Enables `--dangerously-skip-permissions` to be passed; on its own does not bypass. Appropriate only in controlled CI sandboxes. |
| `--allowedTools <list>`                      | Tools in the list do not prompt for permission; tools outside the list still prompt under default mode. |
| `--disallowedTools <list>`                   | Tools in the list are denied without prompting.                    |

Source: `claude --help` v2.1.152 (recorded in this sandbox).

### Working predicate (for `agents/claude.ts`)

Based on cross-TUI-agent convention and the visible permission-prompt
shapes observed when prior versions of claude have rendered them
(`Allow [Y]/n?`, `Permission required — accept / 1. yes / 2. no` style),
the classifier's `permissionPrompt` predicate is expected to be a small
**disjunction** rather than a single matcher. The empty fixture today
documents the schema for it; the populated version names each disjunct.

```ts
// File: agents/claude.ts (substrate v0.0.1, working shape)
// The exact substrings are TBD pending creds-staged enumeration; the
// disjunction shape is the structural commitment.
export const permissionPrompt = (pane: string): boolean =>
  PROMPT_DISJUNCTS.some((d) => pane.includes(d));
```

### Doc-guardrail compliance (security-infra)

- Filename is `permission-prompt-classifier-fixture.json`. Section heading
  is "Classifier predicates for permission prompts." Both per plan §"Security
  guards" → "Doc guardrails for item 4".
- Mandatory `purpose` statement appears in three places:
  - First paragraph of this section ✓
  - `purpose` field of the JSON fixture ✓ (verbatim)
  - (Validator enforces verbatim match — non-verbatim fails lint.)
- No imperative voice. The flag table describes EFFECTS, not actions.
  `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions`
  carry the warning prefix `⚠ … appropriate only in controlled CI sandboxes`.
- No third-party MCP servers in the validator's allow-list.

### What unblocks population

Either (a) a CI environment with a service-account claude API key staged
as a GitHub secret, OR (b) the substrate-build engineer running the
enumeration locally with `claude auth` already complete on their machine
and pushing the populated fixture in the first acceptance pass.

**Decision:** `permissionPrompt` is a small disjunction of pane-text substrings, populated by `research/fixtures/permission-prompt-classifier-fixture.json` and consumed by `agents/claude.ts`. The schema, validator, Vitest replay, and containerized CI workflow are in place and pass lint with an empty `scenarios` array. Enumeration is named explicitly as the first task of the substrate-build acceptance pass with authenticated claude available; this research sprint does not have credentials to enumerate empirically.

---

## 5. `tmux capture-pane -S -N` semantics on long sessions

### Coverage

Tested on tmux 3.6 / Linux x86_64. tmux 3.0 / 3.2 / 3.4 / 3.5a and macOS were
unavailable in this sandbox — `capture-pane`'s `-S` / `-E` flag semantics have
been stable since tmux 2.x (the `-S` syntax for "lines into history" has been
unchanged since the introduction of the feature), so the structural finding
below is expected to hold across the matrix; production-time verification on
the supported platforms is the right time to widen this.

### Reproduction

```bash
source research/harness/harness.sh
tmux -L "$TMUX_SOCKET" new-session -d -s probe5 -x 80 -y 24 "bash --noprofile --norc"
tmux -L "$TMUX_SOCKET" send-keys -t probe5 \
  'for i in $(seq 1 200); do echo "OL-$i"; done; echo OVERFLOW_DONE' C-m
sleep 0.8

tmux -L "$TMUX_SOCKET" capture-pane -p -t probe5 | wc -l              # → pane_height
tmux -L "$TMUX_SOCKET" capture-pane -p -t probe5 | tail -5             # → bottom 5 of live visible
tmux -L "$TMUX_SOCKET" capture-pane -p -t probe5 -S -10 | wc -l        # → pane_height + 10
```

### What `-S -N` actually returns

The plan framed `-S -N` as "the visible bottom-N region." That is **wrong**.
From `man tmux`:

> `-S start-line` — The starting line, 0 being the first line of the visible
> pane and negative numbers being lines in the history.
> `-E end-line` — defaults to the bottom of the visible region.

So `-S -N` captures from `N` lines into history through the bottom of the
visible region. The total line count returned is `N + pane_height`, bounded
by the actual scrollback available.

| Invocation             | Lines returned (pane_height = 24)  | First line                        |
|------------------------|------------------------------------|-----------------------------------|
| `-p` (default)         | 24                                 | top of visible (`OL-177`)          |
| `-p -S -5`             | 29                                 | `OL-174` (5 lines into history)    |
| `-p -S -10`            | 34                                 | `OL-169`                           |
| `-p -S -50`            | 74                                 | `OL-129`                           |
| `-p -S -100`           | 124                                | `OL-79`                            |
| `-p -S -200`           | 203 (capped by history)            | shell command line (top of buffer) |
| `-p -S - -E -`         | 203 (all history + visible)        | same as above                      |

### Bottom-N of visible — the idiom that actually works

```bash
tmux -L "$TMUX_SOCKET" capture-pane -p -t <target> | tail -N
```

Or in TypeScript:
```ts
const lines = (await exec('tmux', ['-L', socket, 'capture-pane', '-p', '-t', target]))
  .stdout.split('\n');
const bottom = lines.slice(-N);
```

The default `capture-pane -p` always returns the **live visible region**
(`pane_height` lines), regardless of whether the pane is in copy-mode or
scrolled — see §9 for the rigorous proof.

### Flag notes

- `-J` (join wrapped lines): irrelevant for the classifier; we want the raw
  rendered rows.
- `-e` (preserve escape sequences): claudemux strips ANSI for matching anyway;
  not needed for the default invocation. Plain text is what the classifier
  matches against.
- `-p` (print to stdout) is required for our use case; without it the output
  goes to a tmux paste buffer.

**Decision:** `backends/tmux/capture.ts` uses `tmux -L <socket> capture-pane -p -t <target>` for the live-visible snapshot, then takes `output.split('\n').slice(-N)` for the bottom-N classifier scan. `-S -N` is **not** used because its semantics differ from what was originally planned (it returns `N + pane_height` lines, not bottom-N). The default-invocation result is unaffected by copy-mode (proven empirically in §9), so no copy-mode-aware fallback is needed.

---

## 6. Pane-death + post-mortem `send`/`capture` error mapping

### Coverage

Tested on tmux 3.6 / Linux x86_64. The error strings tmux emits on
"missing target" have been stable across releases (the `cmd_find_target`
code path); the structural mapping is expected to hold across the matrix.

### Reproduction

```bash
source research/harness/harness.sh
tmux -L "$TMUX_SOCKET" -f /dev/null new-session -d -s ka "sleep infinity"

# CASE A: pane stays open after process death (remain-on-exit = on)
tmux -L "$TMUX_SOCKET" new-session -d -s caseA -x 80 -y 24
tmux -L "$TMUX_SOCKET" set-window-option -t caseA remain-on-exit on
tmux -L "$TMUX_SOCKET" respawn-pane -t caseA -k 'echo SLEEPSTART; exec sleep 600'
pane_pid=$(tmux -L "$TMUX_SOCKET" display-message -p -t caseA '#{pane_pid}')
kill -9 "$pane_pid"   # ONLY this PID, by exact number. NEVER pkill claude.

# CASE B: pane gone (remain-on-exit = off, the default)
# Same setup, but `set-window-option remain-on-exit off`.
```

### Case A: process dead, pane lingers (`remain-on-exit on`)

`pane_dead = 1`, `list-sessions` still reports the session.

| Command                                | Exit | stdout                                              | stderr        |
|----------------------------------------|------|-----------------------------------------------------|---------------|
| `send-keys -t caseA "hello" C-m`       | **0**  | (empty)                                             | (empty)       |
| `capture-pane -p -t caseA`             | 0    | blank lines + literal `Pane is dead (signal 9, <ts>)` | (empty)       |
| `list-sessions`                        | 0    | session entries including `caseA: 1 windows ...`    | (empty)       |
| `has-session -t caseA`                 | 0    | (empty)                                             | (empty)       |
| `list-panes -t caseA`                  | 0    | includes `(dead)` marker                            | (empty)       |
| `display-message -p -t caseA '#{pane_dead}'` | 0 | `1`                                                | (empty)       |
| `kill-session -t caseA`                | 0    | (empty)                                             | (empty)       |

**Trap:** `send-keys` returns `exit=0` for a dead pane. The keystrokes are
silently dropped — there's no error. The classifier **must not** treat
"send-keys succeeded" as proof the agent is alive; the live oracle is
`#{pane_dead}` or the `Pane is dead (signal N, <ts>)` annotation visible in
`capture-pane` output.

**Detection rule for `Case A`:** `display-message -p '#{pane_dead}'` returns
`1`, OR `capture-pane -p` output contains `^Pane is dead \(signal \d+, `.

### Case B: pane gone (`remain-on-exit off` — the default)

Session/window/pane are all removed. `list-sessions` no longer mentions them.

| Command                                | Exit | stderr (lowercased substring match)             |
|----------------------------------------|------|-------------------------------------------------|
| `send-keys -t caseB ...`               | 1    | `can't find pane: caseB`                        |
| `capture-pane -p -t caseB`             | 1    | `can't find pane: caseB`                        |
| `has-session -t caseB`                 | 1    | `can't find session: caseB`                     |
| `list-panes -t caseB`                  | 1    | `can't find window: caseB`                      |
| `kill-session -t caseB`                | 1    | `can't find session: caseB`                     |
| `display-message -p -t caseB ...`      | **0** | (empty stdout, empty stderr)                   |

`display-message` is the odd one out — it silently returns success with empty
output. Don't use it as the liveness probe. `has-session` is the clean signal.

### Typed errors for `backends/tmux/exec.ts`

```ts
type TmuxOpError =
  | { kind: 'PaneDead'; signal: number; deadSince: Date }    // Case A
  | { kind: 'SessionGone'; target: string }                   // Case B
  | { kind: 'TmuxUnreachable'; underlying: Error };           // tmux server down

// Mapping rule (all matching is on lowercased stderr substring):
//   exit 0 && capture-pane output matches /^Pane is dead \(signal (\d+), /  -> PaneDead
//   exit 1 && stderr contains "can't find session:" or "can't find pane:" or "can't find window:" -> SessionGone
//   exec spawn fails / "no server running" / connection refused                -> TmuxUnreachable
```

### Process-group orphan enumeration (security-infra extension)

```bash
# Spawn pane with bash; bash backgrounds a child sleep and then foreground sleeps.
tmux -L "$TMUX_SOCKET" new-session -d -s p -x 80 -y 24 \
  "bash -c 'echo \$\$ > /tmp/p.pid; ( sleep 999 ) & echo \$! > /tmp/c.pid; sleep 998'"
sleep 1
p_pid=$(cat /tmp/p.pid)
c_pid=$(cat /tmp/c.pid)
ppgid=$(ps -o pgid= -p "$p_pid" | tr -d ' ')   # → same pgid as p_pid (tmux puts the pane in its own pg)
cpgid=$(ps -o pgid= -p "$c_pid" | tr -d ' ')   # → equal to ppgid
```

**Finding:** tmux puts the pane process in its own process group; backgrounded
children inherit the pgid. **`kill -9 <pane_pid>` against the pane process
effectively kills the whole pgid** — tmux closes the PTY, which sends `SIGHUP`
to every process in the foreground process group of that controlling
terminal. The child sleep dies along with the parent. Verified:

| Strategy                                | Parent survives? | Child survives? |
|-----------------------------------------|------------------|-----------------|
| `kill -9 <pane_pid>` only                | NO               | **NO** (SIGHUP via PTY close) |
| `kill -KILL -- -<pgid>` (whole pg)       | NO               | NO              |

**Orphan case — children that explicitly `setsid` out of the pane's session:**
those lose the controlling tty and survive the SIGHUP. The common case
(`bash`, `git`, MCP servers spawned via `npx`, ad-hoc sub-shells) shares
the controlling tty and dies cleanly. For v0.0.1's MCP / hooks topology,
the default `kill -9 <pane_pid>` is the right primitive — no explicit
pgid cleanup needed for the common case. If a future agent integration
turns out to spawn `setsid`-detached daemons, the cleanup primitive
becomes `kill -KILL -- -$(ps -o pgid= -p $pane_pid)`.

**Safety:** any cleanup MUST be by exact captured PID/PGID, never by name.
The Linux user this sandbox runs under is also called `claude`; a
`pkill claude` or `pgrep -f /home/claude/.local/bin/claude` will hit the
founder's live Claude Code session. See `research/README.md` "Safety:
kill only PIDs the probe itself spawned."

### PTY half-state — the two states are distinct

- **Case A** (pane open, process dead): tmux still owns the PTY; the pane is
  in the data model with `pane_dead=1`. Liveness via `#{pane_dead}` or the
  `Pane is dead` annotation in capture.
- **Case B** (pane gone): tmux has reaped the PTY; the target name resolves
  to nothing. Liveness via `has-session` exit code.

Different error code paths, different mappings, both required.

### JSONL transcript truncation note (out of v0.0.1 scope)

`SIGKILL`'d claude truncates its JSONL transcript mid-write — the last
record may be incomplete or missing the closing brace. Future
transcript-ingestion consumers (not v0.0.1) must defensively parse the
last line with try/catch and drop a malformed tail record. Documented
here so it isn't re-discovered later.

**Decision:** `backends/tmux/exec.ts` exposes a `TmuxOpError` union of `{ PaneDead, SessionGone, TmuxUnreachable }`, mapped from (a) `#{pane_dead}` / `Pane is dead (signal N, …)` capture-pane annotation for `PaneDead` (Case A), (b) `can't find pane:` / `can't find session:` / `can't find window:` stderr substrings + exit=1 for `SessionGone` (Case B), and (c) spawn-time errors / `no server running` for `TmuxUnreachable`. Cleanup is `kill -9 <pane_pid>` (which transitively kills the pane's pgid via PTY-close SIGHUP for the common case). `setsid`-detached descendants are out of v0.0.1 scope but documented above.

---

## 7. Boot dialog enumeration on a fresh `~/.claude/`

### Coverage

Tested on claude **v2.1.152**, Linux x86_64, fresh sandbox HOME. Two dialogs
fully observed (pre-auth); post-auth enumeration requires staged
credentials and an OAUTH-completable environment, which this sandbox does
not provide. The post-auth section below documents the **partial
enumeration with explicit gaps** and the path to widen.

The spec assumed "trust folder" was *the* dialog — empirically it's not the
first. The first two dialogs are **theme picker** and **login method**.
"Trust folder" is a per-cwd dialog that triggers when claude is run in a
non-trusted directory in interactive (TTY) mode — `claude --help` documents
that `-p` / non-TTY mode skips it.

### Reproduction

```bash
source research/harness/harness.sh
tmux -L "$TMUX_SOCKET" -f /dev/null new-session -d -s ka "sleep infinity"

# Spawn claude in a clean sandbox HOME, inside a tmux pane (TTY).
tmux -L "$TMUX_SOCKET" new-session -d -s cl -x 120 -y 40 \
  "env -i HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME \
   XDG_DATA_HOME=$XDG_DATA_HOME XDG_CACHE_HOME=$XDG_CACHE_HOME \
   XDG_STATE_HOME=$XDG_STATE_HOME \
   PATH=/home/claude/.local/bin:/usr/local/bin:/usr/bin:/bin \
   TERM=xterm-256color LC_ALL=C.UTF-8 claude"

sleep 2.5
tmux -L "$TMUX_SOCKET" capture-pane -p -t cl   # → Dialog 1: theme picker

tmux -L "$TMUX_SOCKET" send-keys -t cl "1" Enter
sleep 2.5
tmux -L "$TMUX_SOCKET" capture-pane -p -t cl   # → Dialog 2: login method
# (Cannot proceed further in this sandbox — no staged credentials.)
```

### Observed dialogs (pre-auth, claude 2.1.152)

#### Dialog 1 — Theme picker

- **Matcher (substring):** `Choose the text style that looks best with your terminal`
- **Visible options:** 1. Auto (match terminal) · 2. Dark mode ✔ · 3. Light mode · 4. Dark mode (colorblind-friendly) · 5. Light mode (colorblind-friendly) · 6. Dark mode (ANSI colors only) · 7. Light mode (ANSI colors only)
- **Default highlight:** `❯ 2. Dark mode ✔` (the `❯` is U+276F used as a **menu-selection indicator**, not the REPL ready marker — see §3)
- **Response key for "auto":** `1` then `Enter`
- **Observed frequency:** every fresh `~/.claude/`, regardless of `--dangerously-skip-permissions` (verified — the flag does not skip this dialog)
- **Post-update note:** would re-trigger if claude's stored theme is invalidated; not observed in this sandbox

#### Dialog 2 — Login method picker

- **Matcher (substring):** `Select login method:`
- **Visible options:** 1. Claude account with subscription · 2. Anthropic Console account · 3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI
- **Default highlight:** `❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise`
- **Response keys:** `1`/`2`/`3` then `Enter` — but each path initiates an OAUTH/API flow that **cannot complete in a clean sandbox without external credentials/network**
- **Observed frequency:** every fresh `~/.claude/` with no auth artifacts
- **Suppression in production:** if `~/.claude/` already has valid creds (the founder is already logged in via `claude auth`), this dialog does NOT appear. v0.0.1's spawn-many-claudes design assumes the founder is already authenticated.

### Post-auth dialogs — partial / extrapolated

Per `claude --help`:
- `--print` / `-p` and non-TTY contexts **skip** the workspace trust
  dialog. claudemux's spawned claudes run inside tmux panes (TTY), so the
  trust dialog **does** apply.
- `--permission-mode` accepts six values: `acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, `plan`. The default and `plan`
  modes are the only ones that prompt. `dontAsk` and `bypassPermissions` are
  likely no-prompt modes; verifying these end-to-end requires authenticated
  claude and is item 4's domain.

#### Anticipated dialog 3 — Workspace trust (per `claude --help`)

- **Matcher (substring, based on documented behavior):** `Do you trust the files in this folder?` (exact wording TBD by post-auth probe)
- **Response keys:** typically `1` for "Yes, trust this folder" or `2` for "No"
- **Suppression:** `-p`/`--print` or non-TTY skip. In claudemux's case the pane IS a TTY, so trust **does** apply on first run in a new directory.
- **Observed frequency:** per-cwd, one-time after auth is settled.

#### Anticipated post-update "what's new"

Possible per `claude` release-cycle. Not observed in this sandbox; needs
the "stale-version-marker → upgrade-spawn" simulation called for in the
ticket. Requires post-auth claude.

### Sandbox HOME side-effects to know about

After a single boot attempt, claude writes:
- `$HOME/.claude/backups/`
- `$HOME/.claude/cache/`
- `$HOME/.claude.json` (299 bytes — non-credential init state)

None of this is in `~/.claude/credentials.*` (those would be the auth
artifacts). So a fresh-HOME boot is reproducible — clearing those three
paths restores the first-run state.

### Typed `BootDialog[]` (partial — for `agents/claude.ts`)

```ts
// File: agents/claude.ts (substrate v0.0.1)
// Order is observed-likelihood-first (most-likely-first speeds boot).
// Post-auth entries are anticipated from claude --help; verified by item 7
// follow-up once creds-staged CI is available.
export const BOOT_DIALOGS: ReadonlyArray<BootDialog> = [
  {
    id: 'theme-picker',
    matches: (pane) => pane.includes('Choose the text style that looks best with your terminal'),
    respond: '1',          // 'Auto (match terminal)' — claudemux's most neutral default
    followUp: 'Enter',
    frequency: 'once-per-fresh-home',
  },
  {
    id: 'login-method',
    // Only appears if creds are missing. claudemux's expected state is
    // "founder has already authed once"; if this fires under claudemux, it
    // is a setup error — surface, do not auto-answer.
    matches: (pane) => pane.includes('Select login method:'),
    respond: 'ERROR_LOGIN_REQUIRED' as const,
    frequency: 'once-per-fresh-home (no creds)',
  },
  {
    // Anticipated — verified at substrate-build time with creds available.
    id: 'workspace-trust',
    matches: (pane) => pane.includes('Do you trust the files in this folder?'),
    respond: '1',          // Yes, trust this folder (substrate v0.0.1's cwd is always opt-in by the founder)
    followUp: 'Enter',
    frequency: 'once-per-cwd',
  },
  // Post-update "what's new" — TBD; placeholder for the substrate's first
  // round of acceptance test runs.
];
```

The shape (`{id, matches, respond, followUp?, frequency}`) matches the
`BootDialog` interface placeholder in
`brain/initiatives/claudemux-v0-0-1-minimum-viable-substrate/details.md`
§"Canonical seam interfaces". The substrate build is the right place to
fold the anticipated post-auth dialogs in once a credentialed CI
environment exists.

### Sentinel check

The probe ran under the harness; sentinel mtime is unchanged after the
probe; the founder's real `~/.claude/` was not touched. The temp HOME
under `/tmp/claudemux-research-*` is the only path claude wrote to.

**Decision:** `BootDialog[]` above covers the pre-auth boot path (theme picker → login method) verified empirically on claude 2.1.152. The login-method dialog must be treated as `ERROR_LOGIN_REQUIRED` under claudemux — claudemux assumes the founder is already authenticated; firing this dialog means the setup is wrong, not that we should auto-answer. Workspace trust and post-update dialogs are anticipated from `claude --help` and require a creds-staged CI environment to enumerate fully; this is named explicitly as out-of-scope for the research sprint and queued for the substrate build's first acceptance pass.

---

## 8. Per-session tmux option propagation

### Coverage

Tested on tmux 3.6 / Linux x86_64. tmux's option-scope model (server / global /
session / window / pane) has been stable since 2.x. The structural answers
below are expected to hold across the matrix; production-time verification
on the supported platforms is the right place to widen.

### Setup that holds

```bash
source research/harness/harness.sh
# Start the server with -f /dev/null — this is the "never read .tmux.conf" hammer.
# Keepalive session prevents the server from tearing down if no client is attached.
tmux -L "$TMUX_SOCKET" -f /dev/null new-session -d -s ka "sleep infinity"

# Deliberately conflicting globals (proves overrides win):
tmux -L "$TMUX_SOCKET" set-option        -g escape-time      500
tmux -L "$TMUX_SOCKET" set-option        -g history-limit    1000
tmux -L "$TMUX_SOCKET" set-option        -g default-terminal "screen"
tmux -L "$TMUX_SOCKET" set-window-option -g remain-on-exit   on
tmux -L "$TMUX_SOCKET" set-environment   -g LC_ALL           "POSIX"

# Test session with overrides:
tmux -L "$TMUX_SOCKET" new-session -d -s t -x 80 -y 24
tmux -L "$TMUX_SOCKET" set-option        -t t  escape-time      0
tmux -L "$TMUX_SOCKET" set-window-option -t t  history-limit    50000
tmux -L "$TMUX_SOCKET" set-option        -t t  default-terminal "tmux-256color"
tmux -L "$TMUX_SOCKET" set-window-option -t t  remain-on-exit   off
tmux -L "$TMUX_SOCKET" set-environment   -t t  LC_ALL           "C.UTF-8"
```

### Per-option verification

| Option            | Scope it lives at | Override invocation                              | Verified per-session?       | How it was checked                                          |
|-------------------|-------------------|--------------------------------------------------|-----------------------------|-------------------------------------------------------------|
| `escape-time`     | session           | `set-option -t <session> escape-time 0`          | Y                           | `display-message -p -t <pane> '#{escape-time}'` → `0`        |
| `history-limit`   | window            | `set-window-option -t <session> history-limit N` | Y (for new panes)           | New pane in `t`: `#{history_limit}` → `50000`; new pane in `ka`: `1000` |
| `default-terminal`| session           | `set-option -t <session> default-terminal X`     | Y                           | New pane in `t` sees `TERM=tmux-256color`                    |
| `remain-on-exit`  | window            | `set-window-option -t <session> remain-on-exit off` | Y                        | `echo` window in `t` closes cleanly (window gone); in `ka` it lingers with `pane_dead=1` |
| `LC_ALL` (env)    | session env       | `set-environment -t <session> LC_ALL C.UTF-8`    | Y (for new spawns)          | New pane in `t` echoes `LC_ALL=C.UTF-8`; existing pane sees empty |

All five options are settable per-session/per-window. No option needed a
server-wide-only setting; the `-f /dev/null` flag handles the "never read
`~/.tmux.conf`" requirement.

### Subtleties the substrate must honor

1. **Order matters: set options BEFORE the pane runs anything that depends
   on them.** `history-limit` is allocated at pane creation; raising it
   *after* the pane has already started won't grow the existing buffer.
   `set-environment` only affects child processes spawned by tmux **after**
   the call; existing panes keep their original env.

2. **Window-scope options (`history-limit`, `remain-on-exit`) need
   `set-window-option -t <session>` (or `set-option -t <session> -w`).**
   They apply to the current window of the session at the time of the call;
   new windows inherit the session's window-option scope.

3. **`-f /dev/null` + private socket is the actual "never reads ~/.tmux.conf"
   guarantee.** Without `-f /dev/null`, tmux reads the user's
   `~/.tmux.conf` on first server start (the private socket alone doesn't
   prevent the read — it just prevents collision with the user's server).
   The harness's `tmux -L claudemux-research -f /dev/null …` pattern is
   what the production substrate must mirror.

4. **The substrate's "one session, one window, one pane" topology fits
   cleanly.** Suggested startup sequence in `backends/tmux/options.ts`:
   - `new-session -d -s <agent> -x 80 -y 24 -e LC_ALL=C.UTF-8 "sleep infinity"` (`-e` sets env at session-create; the holder pane is replaced below)
   - `set-option -t <agent> escape-time 0`
   - `set-option -t <agent> default-terminal "tmux-256color"`
   - `set-window-option -t <agent> history-limit 50000`
   - `set-window-option -t <agent> remain-on-exit off`
   - `respawn-pane -t <agent> -k "<real agent command>"` (replaces the holder)

### v0.0.1 acceptance criterion review

The substrate criterion "**Never reads or writes user's `~/.tmux.conf`**"
holds **unchanged**. No exception list is required. The mechanism is
`tmux -L <private-socket> -f /dev/null …` on every invocation, plus per-session
overrides applied immediately after `new-session`. No update to
`brain/initiatives/claudemux-v0-0-1-minimum-viable-substrate/details.md` is
needed from this item.

**Decision:** Per-session invocation list for `backends/tmux/options.ts`: `escape-time` (session), `history-limit` (window), `default-terminal` (session), `remain-on-exit` (window), `LC_ALL` (session env via `set-environment` or `new-session -e`). All applied immediately after `new-session -d -s <agent>` and before any meaningful command runs in the pane. The `-f /dev/null` flag is required on every tmux command — that is the actual "never reads `~/.tmux.conf`" guarantee. No server-wide-only exceptions surfaced.

---

## 9. Founder-in-copy-mode + capture (SLEEPER)

### Coverage

Tested on tmux 3.6 / Linux x86_64. The behavior under test is governed by
tmux's core data model (the pane buffer is the source-of-truth; copy-mode is
a per-pane viewport state that does not modify the buffer). This has been
stable across tmux releases and is not expected to differ across the matrix.
Production-time verification on macOS / older tmux when the substrate ships
is the right place to widen.

### The question

When the founder runs `tmux attach` and scrolls the pane into copy-mode, does
`capture-pane -p -t <target>` return the live tail or the historical
(scrolled-back) view? Per v0.0.1's acceptance criterion ("founder
attaching/detaching mid-flight does not corrupt state"), if capture silently
reads the stale scrolled view during copy-mode, the classifier returns wrong
answers, `wait` returns wrong, and consumer queues stall.

Three candidate behaviors named in the plan:
- **(a)** Default capture is unaffected by copy-mode → keep current plan.
- **(b)** Force `send-keys -X cancel` pre-capture → undoes founder's scroll;
  v0.0.1 acceptance criterion must be revised.
- **(c)** A different `capture-pane` invocation bypasses copy-mode
  non-intrusively → revise `capture.ts` only.

### Reproduction

```bash
source research/harness/harness.sh

# Spawn an emitter session: 200 lines at ~12.5 lines/s, then idle.
tmux -L "$TMUX_SOCKET" new-session -d -s probe9 -x 80 -y 24 \
  "bash -c 'for i in \$(seq 1 200); do echo \"emit-\$i\"; sleep 0.08; done; sleep 60'"
sleep 3.0  # let the emitter build up scrollback

# Attach a real client via script(1) so tmux has a PTY-backed client connected.
script -qf -c "tmux -L $TMUX_SOCKET attach -t probe9" /dev/null </dev/null >/dev/null 2>&1 &
attach_pid=$!
sleep 0.8
tmux -L "$TMUX_SOCKET" list-clients -t probe9   # → 1 attached client

# Drive the attached client into copy-mode and scroll back 3 pages.
tmux -L "$TMUX_SOCKET" copy-mode -t probe9
tmux -L "$TMUX_SOCKET" send-keys -t probe9 -X page-up
tmux -L "$TMUX_SOCKET" send-keys -t probe9 -X page-up
tmux -L "$TMUX_SOCKET" send-keys -t probe9 -X page-up
sleep 0.3

# Verify state.
tmux -L "$TMUX_SOCKET" display-message -p -t probe9 '#{pane_in_mode}'        # → 1
tmux -L "$TMUX_SOCKET" display-message -p -t probe9 '#{scroll_position}'      # → 25 (rows scrolled back)
sleep 2.0  # emitter keeps producing while we're scrolled back

# THE TEST: what does capture return?
tmux -L "$TMUX_SOCKET" capture-pane -p -t probe9 | tail -5

# Cleanup: kill the script process we spawned (by exact PID, never by name —
# see research/README.md "Safety: kill only PIDs the probe itself spawned").
kill "$attach_pid" 2>/dev/null
```

### Results — per-invocation × per-scenario

| Scenario                                                  | `capture -p` returns                  | Matches live tail? |
|-----------------------------------------------------------|---------------------------------------|--------------------|
| No copy-mode, no client attached                          | live visible region                   | Y                  |
| Pane in copy-mode, no client attached, scrolled back      | live visible region (last `emit-N`)   | Y                  |
| Pane in copy-mode, real client attached at the bottom     | live visible region                   | Y                  |
| **Pane in copy-mode, real client attached, scrolled back 3 pages, emitter still running** | live visible region (emit-71 .. emit-74 in the trace) | **Y** |

The decisive trace (5.8s into emit, ~73 lines produced, `pane_in_mode=1`,
`scroll_position=25`, attached client `/dev/pts/4`):

```
emit-71
emit-72
emit-73
emit-74
```

The attached client's screen at that moment was showing approximately
`emit-25 .. emit-49` (`scroll_position=25`, `pane_height=24`). `capture -p`
returned a completely different window — the live tail.

### Why this is the case (tmux data model)

tmux's pane buffer is a single source of truth that keeps growing. Copy-mode
is a per-pane viewport state (`pane_in_mode=1`, `scroll_position=N`) that
controls what's *rendered* to attached clients. `capture-pane` reads from the
buffer at "the visible region" — where "visible" tracks the live (newest)
position, not the copy-mode viewport. The tmux source-level evidence: the
copy-mode viewport state is implemented as a `window_copy_mode_data`
overlay; `capture-pane` walks the underlying grid directly.

### Implication for v0.0.1 acceptance

The acceptance criterion "Founder attaching/detaching via `tmux attach`
mid-flight does not corrupt state" stands **unchanged**. The classifier sees
the live tail regardless of what the founder is doing in copy-mode. No
intrusive `send-keys -X cancel` is needed; no alternative capture invocation
is needed; `capture.ts` and `wait.ts` keep the simple form. No update to
`brain/initiatives/claudemux-v0-0-1-minimum-viable-substrate/details.md` is
required as a result of this item.

**Decision:** (a) — default `capture-pane -p -t <target>` is unaffected by copy-mode (per-pane viewport state) and by client attachment, even when the founder is actively scrolled back while output continues to arrive. `backends/tmux/capture.ts` uses the default invocation; v0.0.1's "founder attaching/detaching mid-flight does not corrupt state" acceptance criterion is empirically supportable as written.

---

## What's done, what's next

This sprint resolved or de-risked nine empirical unknowns that gated the
substrate build. Below is the per-decision handoff for the substrate
engineer — which file each decision lands in, and where the partial-coverage
items still need to widen at substrate-build acceptance time.

### Empirically settled — substrate engineer should treat these as decided

| § | Decision                                                           | Lands in                                       |
|---|---------------------------------------------------------------------|------------------------------------------------|
| 9 | (a) default `capture-pane -p` is unaffected by copy-mode            | `backends/tmux/capture.ts` (also closes v0.0.1 acceptance criterion unchanged) |
| 5 | `capture-pane -p` + shell-side `tail -N` (NOT `-S -N`) for bottom-N | `backends/tmux/capture.ts`                     |
| 6 | `TmuxOpError = { PaneDead, SessionGone, TmuxUnreachable }` mapping  | `backends/tmux/exec.ts`                        |
| 8 | Per-session option list + `-f /dev/null` for "no .tmux.conf"        | `backends/tmux/options.ts`                     |
| 3 | `❯` = U+276F + classifier must qualify match by line context        | `agents/claude.ts` `idle` predicate; canary lives in `.github/workflows/glyph-canary.yml` |

### Settled with working decision; receiver-side verification deferred

| § | Working decision                                                                                          | What still needs verification                                                       |
|---|------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| 1 | `load-buffer + paste-buffer -p` byte-perfect on tmux side                                                  | Does claude treat the payload as ONE logical turn? Needs authenticated claude       |
| 2 | Normalize body terminators to `\n`, submit via separate `send-keys Enter` outside the brackets             | Same — needs authenticated claude to observe `\r`/`\n`/`\r\n` interpretation        |
| 7 | `BootDialog[]` covers theme picker + login picker pre-auth (login = `ERROR_LOGIN_REQUIRED` under claudemux) | Workspace trust + post-update dialogs — anticipated from `claude --help`, need creds |
| 4 | Predicate is a small disjunction; schema/validator/Vitest/workflow in place                                 | `scenarios: []` — populate at substrate-build acceptance with authenticated claude  |

### Substrate-build first-acceptance task list (carried from above)

1. Spawn authenticated claude in a tmux pane; send a multi-line bracketed
   paste payload `A\nB\nC\n`; confirm one logical turn arrives with
   literal newlines preserved. Update §1+2 in this doc.
2. Same setup; enumerate workspace-trust dialog text + response key; add
   to `BootDialog[]` in `agents/claude.ts` and §7 here.
3. Same setup; enumerate every permission-prompt shape per `(scenario ×
   flag-combo)` matrix; populate
   `research/fixtures/permission-prompt-classifier-fixture.json` and
   verify the fixture validator + Vitest pass with the populated data.

### Conditional v0.0.1 substrate `details.md` updates

| Trigger from the plan                                                          | Outcome                                | Update needed? |
|--------------------------------------------------------------------------------|-----------------------------------------|----------------|
| Item 9 returns (b) or (c) — capture corrupts in copy-mode                       | **Returned (a) — favorable**            | **No**         |
| Item 1 finds bracketed-paste broken on tmux 3.0                                  | Not fully testable here (single version); no evidence of breakage in the delivery probe | **No** under working decision; revisit at receiver-side probe |
| Item 8 finds any option requires server-wide setting                            | **None did. `-f /dev/null` + per-session overrides suffice.** | **No**         |

No conditional updates to `brain/initiatives/claudemux-v0-0-1-minimum-viable-substrate/details.md` are required from this research sprint. The favorable cases held.

### Durable CI canaries shipped

- `.github/workflows/glyph-canary.yml` — daily glyph drift check; non-blocking; auto-files a tracking issue on failure.
- `.github/workflows/permission-prompts.yml` *(retired/superseded — deleted in the Path-B simplification; see ticket `12455a20` / decision 0010)* — fixture re-validation on push + daily; ran inside a container with `--network=none --read-only`; lint-step belt-and-braces refused to run if cwd / `$HOME` looked real.

### Environment caveat (carried in each section)

Every probe in this doc ran under tmux 3.6 / Linux x86_64. The plan called
for tmux 3.0 / 3.2 / 3.4 / 3.5a × macOS + Linux. For decisions governed by
tmux's core data model (capture-pane semantics, copy-mode viewport, option
scope) the structural answer is stable across the matrix and the single-version
finding is the working decision. The full matrix verification happens at
substrate-build CI time on the supported platforms.
