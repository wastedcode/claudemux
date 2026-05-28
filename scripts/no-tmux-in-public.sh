#!/usr/bin/env bash
# no-tmux-in-public — enforce the PTY-shaped-public-API promise.
#
# The substrate's public surface is backend-neutral. Zero references to
# "tmux" appear in:
#
#   - src/index.ts (the re-export front door)
#   - src/types.ts (public types)
#   - src/errors.ts (typed errors — exported error names included)
#   - any --help output emitted by bin/claudemux
#
# Why: future backends (node-pty, CustomPaneBackend) slot in without
# rewriting the consumer's `import { create } from "claudemux"` code.

set -u

ROOT="${1:-.}"
violations=0

PUBLIC_FILES=("$ROOT/src/index.ts" "$ROOT/src/types.ts" "$ROOT/src/errors.ts")

for f in "${PUBLIC_FILES[@]}"; do
  [ -f "$f" ] || continue
  if matches=$(grep -iEHn '\btmux\b' "$f" 2>/dev/null); then
    if [ -n "$matches" ]; then
      echo "no-tmux-in-public: 'tmux' appears in public-surface file:" >&2
      echo "$matches" >&2
      violations=$((violations + 1))
    fi
  fi
done

# --help output check: only runnable if the bin is built. Skip silently if
# dist/ doesn't exist (CI runs npm run build before this; local dev may not).
BIN="$ROOT/bin/claudemux"
if [ -x "$BIN" ] && [ -d "$ROOT/dist" ]; then
  VERBS=("" spawn send wait state capture kill list exists)
  for v in "${VERBS[@]}"; do
    if help_out=$("$BIN" $v --help 2>&1); then
      if echo "$help_out" | grep -qiE '\btmux\b'; then
        echo "no-tmux-in-public: 'tmux' appears in 'claudemux $v --help' output" >&2
        echo "$help_out" | grep -iE '\btmux\b' >&2
        violations=$((violations + 1))
      fi
    fi
  done
fi

if [ "$violations" -gt 0 ]; then
  echo "no-tmux-in-public: $violations violation(s) found" >&2
  exit 1
fi
exit 0
