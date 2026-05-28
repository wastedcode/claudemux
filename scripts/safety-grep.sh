#!/usr/bin/env bash
# safety-grep — enforce two cross-cutting safety rules tree-wide:
#
#   1. Peer-process matching by name is BANNED. claudemux runs as a peer to
#      the founder's live claude session, often under the same Linux user.
#      A casual peer-kill would silently kill the founder's REPL —
#      collateral damage; instant trust loss. PID/PGID only, captured at
#      spawn. See decisions/0004-peer-process-safety.
#
#   2. Every shell `tmux` invocation in this repo must carry `-f /dev/null`.
#      The substrate's "never reads ~/.tmux.conf" promise hinges on it; bare
#      `-L <socket>` does not prevent the read. See
#      engineer/wiki/tmux-private-server-bootstrap.
#
# Scans src/ test/ examples/ scripts/. Allows brain/, node_modules/, dist/.
#
# Comment-only lines (TSDoc, // ..., # ...) are skipped — those are
# documentation OF the rule, not violations.
#
# Exit codes: 0 = clean; non-zero = violations printed to stderr.

set -u

ROOT="${1:-.}"
SCAN_DIRS=()
for d in src test examples scripts; do
  if [ -d "$ROOT/$d" ]; then SCAN_DIRS+=("$ROOT/$d"); fi
done

# Exclusions: the safety-grep meta-test file contains banned patterns as
# string literals (by design — they prove the script catches them). Skip
# only that file by name so the rule and its tests don't chase each other.
GREP_EXCLUDES=(--exclude=safety-grep.test.ts)

# True when the line is a comment (or comment-prefix in a JSDoc/markdown
# context). We use grep -v with this in a pipeline.
is_comment_line() {
  # Matches: whitespace then //, *, or # at line start.
  grep -E '^[[:space:]]*(//|\*|#)'
}

violations=0

# Rule 1: banned peer-process name matchers — only flag if they look like a
# live command (not a doc citation). Heuristic: the pattern appears outside
# any leading-comment-prefix.
BANNED_PATTERNS=(
  'pkill[[:space:]]+claude'
  'killall[[:space:]]+claude'
  'pgrep[[:space:]]+(-f[[:space:]]+)?claude'
  'ps[[:space:]].*\|[[:space:]]*grep[[:space:]]+claude'
)

for pattern in "${BANNED_PATTERNS[@]}"; do
  matches=$(grep -rEHn "${GREP_EXCLUDES[@]}" "$pattern" "${SCAN_DIRS[@]}" 2>/dev/null | grep -vE ':[[:space:]]*(//|\*|#)' || true)
  if [ -n "$matches" ]; then
    echo "safety-grep: BANNED peer-process matcher (\"$pattern\"):" >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
done

# Rule 2: every shell `tmux <subcommand>` invocation must carry `-f /dev/null`
# in argv. Allowed: lines that contain "-f /dev/null", route through TmuxExec
# (which prepends the flag), or are comment-only.
while IFS= read -r match; do
  file="${match%%:*}"
  rest="${match#*:}"
  line_num="${rest%%:*}"
  content="${rest#*:}"
  # Skip comment-only lines.
  if echo "$content" | grep -qE '^[[:space:]]*(//|\*|#)'; then continue; fi
  # Skip if the line itself has -f /dev/null.
  if echo "$content" | grep -qE -- '-f /dev/null'; then continue; fi
  # Skip TS source lines that route through TmuxExec (which prepends the flag).
  if echo "$content" | grep -qE 'TmuxExec|tmuxArgs|fullArgs ?=|exec\.run|h\.runTmux|h\.tmux\(|"tmux" '; then continue; fi
  echo "safety-grep: tmux invocation missing -f /dev/null at $file:$line_num" >&2
  echo "  $content" >&2
  violations=$((violations + 1))
done < <(grep -rEHn "${GREP_EXCLUDES[@]}" '\btmux[[:space:]]+(-L|new-session|kill-session|has-session|list-sessions|capture-pane|send-keys|set-option|set-window-option|set-environment|display-message|paste-buffer|load-buffer|respawn-pane|kill-server|start-server)' "${SCAN_DIRS[@]}" 2>/dev/null)

if [ "$violations" -gt 0 ]; then
  echo "safety-grep: $violations violation(s) found" >&2
  exit 1
fi
exit 0
