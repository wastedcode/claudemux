#!/usr/bin/env bash
# Best-effort cleanup after a probe run. Safe to call multiple times.
#
#   - Kills the private tmux server on $TMUX_SOCKET (claudemux-research).
#   - Removes the temp HOME_SANDBOX if pointed at /tmp.
#
# Never touches the real ~/.claude/ or the backup tarballs — those persist
# so the founder can roll back if anything went wrong.

set -u

SOCKET="${TMUX_SOCKET:-claudemux-research}"

tmux -L "$SOCKET" kill-server 2>/dev/null || true

if [ -n "${HOME_SANDBOX:-}" ] && [ -d "$HOME_SANDBOX" ]; then
  case "$HOME_SANDBOX" in
    /tmp/*|/var/tmp/*)
      rm -rf "$HOME_SANDBOX"
      ;;
    *)
      echo "teardown.sh: refusing to rm HOME_SANDBOX=$HOME_SANDBOX (not under /tmp or /var/tmp)" >&2
      ;;
  esac
fi
