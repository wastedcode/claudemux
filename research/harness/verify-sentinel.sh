#!/usr/bin/env bash
# Re-assert the do-not-touch sentinel hasn't been modified since backup.sh
# recorded its mtime. Called by probe_run after every probe.
#
# Exits 0  if mtime unchanged.
# Exits 1  with a loud HOME LEAK message if it differs.
# Exits 2  if the sentinel or the mtime record is missing (harness misconfig).

set -u

__self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(cd "$__self/.." && pwd)"
MTIME_FILE="$RESEARCH_DIR/.sentinel-mtime"

REAL_HOME="$(getent passwd "$(id -un)" | awk -F: '{print $6}')"
sentinel="$REAL_HOME/.claude/.do-not-touch-sentinel"

if [ ! -f "$MTIME_FILE" ]; then
  echo "verify-sentinel: missing $MTIME_FILE — did you run backup.sh?" >&2
  exit 2
fi
if [ ! -f "$sentinel" ]; then
  echo "verify-sentinel: sentinel disappeared at $sentinel — HOME LEAK or rollback ran" >&2
  exit 1
fi

recorded="$(cat "$MTIME_FILE")"
current="$(stat -c '%Y' "$sentinel")"

if [ "$recorded" != "$current" ]; then
  echo "verify-sentinel: HOME LEAK — sentinel mtime changed (recorded=$recorded current=$current)" >&2
  echo "                 path=$sentinel" >&2
  exit 1
fi
exit 0
