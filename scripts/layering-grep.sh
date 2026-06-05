#!/usr/bin/env bash
# layering-grep — enforce the substrate's seam discipline:
#
#   - src/backends/** MUST NOT import from src/agents/**.
#   - src/agents/** MUST NOT import from src/backends/**.
#   - src/backends/** MUST NOT contain claude-specific RUNTIME strings
#     (the glyph U+276F as a live string literal, "Choose the text style",
#     "Select login method:", etc.).
#   - src/agents/** MUST NOT reference tmux command names directly as
#     runtime strings.
#
# Comment-only lines (TSDoc / // ... / wiki references) are exempt — those
# document the architecture, they don't violate it.
#
# If you can't draw the layer, the seam is wrong (conventions/architecture.md).

set -u

ROOT="${1:-.}"
violations=0

# Drop lines whose first non-whitespace char marks them as a comment.
# Works for *.ts (// and *), *.sh (#), and similar.
filter_code_lines() {
  grep -vE ':[[:space:]]*(//|\*|#)'
}

# Cross-layer imports — these are unambiguous regardless of comments.
if matches=$(grep -rEHn "from ['\"]\.\./agents/" "$ROOT/src/backends/" 2>/dev/null); then
  if [ -n "$matches" ]; then
    echo "layering-grep: src/backends/ imports from src/agents/ — banned" >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi
if matches=$(grep -rEHn "from ['\"]\.\./backends/" "$ROOT/src/agents/" 2>/dev/null); then
  if [ -n "$matches" ]; then
    echo "layering-grep: src/agents/ imports from src/backends/ — banned" >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi

# Claude-specific RUNTIME strings in the backend. Look for them inside
# double-quoted string literals or template literals on non-comment lines.
CLAUDE_RUNTIME_STRINGS=(
  '"Choose the text style"'
  '"Select login method:"'
  '"Do you trust"'
)
for s in "${CLAUDE_RUNTIME_STRINGS[@]}"; do
  if matches=$(grep -rEHn -- "$s" "$ROOT/src/backends/" 2>/dev/null | filter_code_lines); then
    if [ -n "$matches" ]; then
      echo "layering-grep: claude-runtime-string $s in src/backends/ — banned" >&2
      echo "$matches" >&2
      violations=$((violations + 1))
    fi
  fi
done

# The ❯ glyph as a live string in backends/ (a string literal containing it).
# Pure-comment uses in docstrings are fine.
if matches=$(grep -rHn '"❯"\|'\''❯'\''' "$ROOT/src/backends/" 2>/dev/null | filter_code_lines); then
  if [ -n "$matches" ]; then
    echo "layering-grep: claude ready-glyph (U+276F) as runtime string in src/backends/ — banned" >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi

# Tmux command names as runtime strings in src/agents/.
TMUX_CMD_STRINGS=(
  '"new-session"' '"kill-session"' '"has-session"' '"list-sessions"'
  '"capture-pane"' '"send-keys"' '"set-option"' '"set-window-option"'
  '"paste-buffer"' '"load-buffer"' '"set-environment"' '"display-message"'
)
for c in "${TMUX_CMD_STRINGS[@]}"; do
  if matches=$(grep -rEHn -- "$c" "$ROOT/src/agents/" 2>/dev/null | filter_code_lines); then
    if [ -n "$matches" ]; then
      echo "layering-grep: tmux runtime string $c in src/agents/ — banned" >&2
      echo "$matches" >&2
      violations=$((violations + 1))
    fi
  fi
done

# Transcript / JSONL vocabulary — claude's on-disk session-log knowledge (the
# `.jsonl` extension, the `.claude/projects` location, the `message.content`
# record shape) must stay in src/agents/**. The agent-agnostic Observer reads
# the transcript via AgentDef.transcript.* and never knows the schema or path
# rule. Comment lines and *.test.ts are exempt.
TRANSCRIPT_VOCAB='\.jsonl|\.claude/projects|message\.content'
if matches=$(grep -rEHn --include='*.ts' --exclude='*.test.ts' -- "$TRANSCRIPT_VOCAB" "$ROOT/src/" 2>/dev/null | grep -v '/agents/' | filter_code_lines); then
  if [ -n "$matches" ]; then
    echo "layering-grep: transcript/jsonl vocabulary outside src/agents/ — banned (use AgentDef.transcript.*)" >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi

if [ "$violations" -gt 0 ]; then
  echo "layering-grep: $violations violation(s) found" >&2
  exit 1
fi
exit 0
