#!/usr/bin/env bash
# Sourceable safety harness for every claudemux pre-build research probe.
#
# Contract:
#   - Probes source this file, then call `probe_run "<item-id>" -- <cmd...>`.
#   - All probe execution happens under `env -i` with a sandbox HOME so the
#     founder's real ~/.claude/ and ~/.tmux.conf can never be touched.
#   - Every probe invocation appends one JSONL line to research/run-log.jsonl.
#   - Every probe invocation re-verifies the do-not-touch sentinel.
#
# Required tools on PATH for sourcing: bash, mktemp, mkdir, tmux, sha256sum, jq.
# probe_run will fail loudly if any of these are missing.

set -u

# ---- repo root resolution (script must work from any cwd) ---------------
__harness_self="${BASH_SOURCE[0]:-$0}"
__harness_dir="$(cd "$(dirname "$__harness_self")" && pwd)"
RESEARCH_DIR="$(cd "$__harness_dir/.." && pwd)"
RUN_LOG="$RESEARCH_DIR/run-log.jsonl"
SENTINEL_MTIME_FILE="$RESEARCH_DIR/.sentinel-mtime"

# ---- sandbox HOME + XDG_* under a temp tree ------------------------------
# Re-uses an existing sandbox if HOME_SANDBOX is already set in the env
# (lets a probe stage state before calling probe_run). Otherwise creates one.
if [ -z "${HOME_SANDBOX:-}" ]; then
  HOME_SANDBOX="$(mktemp -d -t claudemux-research-XXXXXX)"
fi
export HOME_SANDBOX
export HOME="$HOME_SANDBOX"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

# ---- private tmux socket -------------------------------------------------
# Every tmux invocation in probes MUST use `tmux -L "$TMUX_SOCKET"`.
export TMUX_SOCKET="claudemux-research"

# ---- discovery of OS + tmux version (for run log) ------------------------
__harness_os="$(uname -s 2>/dev/null || echo unknown)-$(uname -m 2>/dev/null || echo unknown)"
__harness_tmux_version="$(tmux -V 2>/dev/null || echo 'tmux unavailable')"

# ---- json-escape helper (handles quotes, backslashes, control chars) ----
__harness_json_escape() {
  jq -Rn --arg s "$1" '$s'
}

# ---- probe_run -----------------------------------------------------------
# Usage: probe_run "<item-id>" -- <cmd...>
# Wraps the command, captures exit code + a sha256 hash of its combined
# stdout+stderr, appends a JSONL row, then re-verifies the sentinel.
#
# The wrapped command's stdout AND stderr are merged and re-emitted on the
# caller's stdout (so the caller can pipe or eyeball it). Splitting them
# would require process-substitution gymnastics that aren't worth it for
# research probes — we only ever want one combined "what did it print"
# stream and a single hash of it in the run log.
probe_run() {
  if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
    echo "probe_run: usage: probe_run <item-id> -- <cmd...>" >&2
    return 2
  fi
  local item="$1"
  shift 2

  # We run the command under `env -i` with only the sandboxed paths +
  # PATH explicitly set. Inherited XDG_* / HOME come back in via -.
  local out
  local exit_code
  out="$(env -i \
    HOME="$HOME" \
    XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    XDG_CACHE_HOME="$XDG_CACHE_HOME" \
    XDG_DATA_HOME="$XDG_DATA_HOME" \
    XDG_STATE_HOME="$XDG_STATE_HOME" \
    TMUX_SOCKET="$TMUX_SOCKET" \
    TERM="${TERM:-xterm-256color}" \
    LC_ALL="C.UTF-8" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    "$@" 2>&1)"
  exit_code=$?

  # Forward output to the calling shell.
  printf '%s\n' "$out"

  local hash
  hash="$(printf '%s' "$out" | sha256sum | awk '{print $1}')"

  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  # Build the JSONL row with jq so escapes are correct.
  local cmd_str
  cmd_str="$(printf '%q ' "$@" | sed 's/ $//')"
  jq -cn \
    --arg ts "$ts" \
    --arg item "$item" \
    --arg cmd "$cmd_str" \
    --argjson exit "$exit_code" \
    --arg output_hash "$hash" \
    --arg tmux_version "$__harness_tmux_version" \
    --arg os "$__harness_os" \
    '{ts:$ts, item:$item, cmd:$cmd, exit:$exit, output_hash:$output_hash, tmux_version:$tmux_version, os:$os}' \
    >> "$RUN_LOG"

  # Re-verify sentinel. Failure here is a HOME LEAK and is fatal.
  if ! "$__harness_dir/verify-sentinel.sh" >&2; then
    echo "probe_run: sentinel check FAILED after item=$item — aborting" >&2
    return 99
  fi

  return $exit_code
}

# ---- tmux convenience wrapper -------------------------------------------
# All probes should call this rather than bare `tmux`, so the private socket
# is uniformly applied. Kept tiny on purpose.
tmuxp() { tmux -L "$TMUX_SOCKET" "$@"; }
export -f tmuxp 2>/dev/null || true
