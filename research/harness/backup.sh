#!/usr/bin/env bash
# One-shot, idempotent pre-research backup + sentinel install.
# Run ONCE before any probe runs. Safe to re-run; backup gets a fresh
# timestamped tarball each time.
#
# Writes:
#   ~/claude-bak-<unix>.tgz      tarball of ~/.claude/ + ~/.tmux.conf (if any)
#   ~/.claude/.do-not-touch-sentinel  the canary file
#   research/.sentinel-mtime     recorded mtime of the sentinel
#
# The sentinel is the load-bearing safety check: every probe re-asserts its
# mtime via verify-sentinel.sh and aborts loudly if it changes.

set -euo pipefail

__self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(cd "$__self/.." && pwd)"
MTIME_FILE="$RESEARCH_DIR/.sentinel-mtime"

# Resolve the founder's real HOME. This script must NOT inherit a sandbox
# HOME from a harness source — we always back up the real user's data.
# If a probe sourced harness.sh before this, HOME may have been redirected;
# we get back to the real one via getent.
REAL_HOME="$(getent passwd "$(id -un)" | awk -F: '{print $6}')"
if [ -z "$REAL_HOME" ] || [ ! -d "$REAL_HOME" ]; then
  echo "backup.sh: could not resolve real HOME for $(id -un)" >&2
  exit 1
fi

ts="$(date +%s)"
backup_path="$REAL_HOME/claude-bak-$ts.tgz"

# Compose the tarball. Errors silenced because either file may legitimately
# not exist on a fresh machine.
tar czf "$backup_path" \
  -C "$REAL_HOME" \
  .claude .tmux.conf 2>/dev/null || true

if [ ! -s "$backup_path" ]; then
  # Tarball is empty (no .claude, no .tmux.conf). Leave a placeholder so
  # subsequent runs are still idempotent and the sentinel still gets dropped.
  : > "$backup_path"
fi

# Drop sentinel into ~/.claude/. Create the dir if missing (a fresh machine
# might not have claude installed yet). This is the only write the harness
# ever does to the real HOME; the sentinel-mtime check is what proves it.
mkdir -p "$REAL_HOME/.claude"
sentinel="$REAL_HOME/.claude/.do-not-touch-sentinel"
if [ ! -f "$sentinel" ]; then
  date -u +'%Y-%m-%dT%H:%M:%SZ' > "$sentinel"
fi

# Record sentinel mtime (epoch seconds) so verify-sentinel.sh can compare.
stat -c '%Y' "$sentinel" > "$MTIME_FILE"

echo "backup.sh: backup -> $backup_path"
echo "backup.sh: sentinel -> $sentinel (mtime recorded at $MTIME_FILE)"
