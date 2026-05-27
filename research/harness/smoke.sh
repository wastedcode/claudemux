#!/usr/bin/env bash
# End-to-end smoke test for the harness contract.
# Runs from a fresh shell. Exits non-zero if anything in the contract breaks.
#
#   1. Source harness.sh -> sandbox HOME + private socket exported.
#   2. backup.sh (idempotent) -> backup tarball + sentinel + mtime recorded.
#   3. A no-op probe via probe_run -> JSONL row appended; sentinel still clean.
#   4. A second probe that touches the sandbox HOME (NOT real HOME).
#   5. teardown.sh -> private server killed; sandbox removed.

set -u

__self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$__self"

fail() { echo "smoke FAIL: $*" >&2; exit 1; }

# --- Step 1: source harness.sh
# shellcheck source=harness.sh
source "$HARNESS_DIR/harness.sh"

[ -d "$HOME" ] || fail "sandbox HOME not created: $HOME"
case "$HOME" in
  /tmp/claudemux-research-*) : ;;
  *) fail "sandbox HOME not under /tmp/claudemux-research-*: $HOME" ;;
esac
[ "$XDG_CONFIG_HOME" = "$HOME/.config" ] || fail "XDG_CONFIG_HOME wrong: $XDG_CONFIG_HOME"
[ -d "$XDG_CONFIG_HOME" ] || fail "XDG_CONFIG_HOME dir missing"

# --- Step 2: backup
"$HARNESS_DIR/backup.sh" >/dev/null || fail "backup.sh exited non-zero"
[ -s "$RESEARCH_DIR/.sentinel-mtime" ] || fail "sentinel mtime file empty"

# --- Step 3: no-op probe
probe_run "smoke-noop" -- true >/dev/null || fail "no-op probe failed"
lines=$(wc -l < "$RUN_LOG")
[ "$lines" -ge 1 ] || fail "run-log empty after no-op probe"

# --- Step 4: a probe that uses tmux + writes inside sandbox HOME
probe_run "smoke-tmux" -- bash -c '
  tmux -L "$TMUX_SOCKET" new-session -d -s smoke "sleep 5" || exit 11
  tmux -L "$TMUX_SOCKET" has-session -t smoke || exit 12
  echo hello > "$HOME/sandbox-write-test"
  tmux -L "$TMUX_SOCKET" kill-session -t smoke
' >/dev/null || fail "tmux probe failed"

# Confirm the sandbox write happened inside the temp HOME (not the real one).
[ -f "$HOME/sandbox-write-test" ] || fail "sandbox-write-test missing — probe didn't write there?"

# --- Sentinel still clean
"$HARNESS_DIR/verify-sentinel.sh" || fail "sentinel changed during smoke"

# --- jq parse check on the entire run log
jq -e '.' "$RUN_LOG" >/dev/null || fail "run-log.jsonl not jq-parseable"

# --- Step 5: teardown
"$HARNESS_DIR/teardown.sh"
[ -d "$HOME" ] && fail "teardown didn't remove sandbox HOME=$HOME"

echo "smoke OK"
