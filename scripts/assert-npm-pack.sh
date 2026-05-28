#!/usr/bin/env bash
# assert-npm-pack — verify the published tarball contents exactly match
# the allow-list. A leak of brain/, or any test fixture into the
# published artifact would expose unintended internal material to consumers.
#
# Allow-list (lexicographically sorted):
#   - CHANGELOG.md
#   - LICENSE
#   - README.md
#   - bin/claudemux
#   - dist/**
#   - package.json
#
# Each line is required; any line OUTSIDE this set is a violation.

set -u

ROOT="${1:-.}"

cd "$ROOT" || exit 1

# `npm pack --dry-run --json` lists files without creating the tarball.
out="$(npm pack --dry-run --json 2>/dev/null)" || {
  echo "assert-npm-pack: npm pack --dry-run failed" >&2
  exit 1
}

# Files are at .[0].files[].path
files="$(printf '%s' "$out" | node -e '
let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  const arr = JSON.parse(raw);
  const files = (arr[0]?.files ?? []).map(f => f.path).sort();
  process.stdout.write(files.join("\n") + "\n");
});
')"

allowed_prefixes=(
  "CHANGELOG.md"
  "LICENSE"
  "README.md"
  "bin/claudemux"
  "package.json"
)

violations=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if [[ "$path" == dist/* ]]; then continue; fi
  matched=0
  for prefix in "${allowed_prefixes[@]}"; do
    if [ "$path" = "$prefix" ]; then matched=1; break; fi
  done
  if [ "$matched" -eq 0 ]; then
    echo "assert-npm-pack: disallowed file in tarball: $path" >&2
    violations=$((violations + 1))
  fi
done <<< "$files"

# Each required file must be present.
required=("CHANGELOG.md" "LICENSE" "README.md" "package.json" "bin/claudemux")
for r in "${required[@]}"; do
  if ! echo "$files" | grep -qx "$r"; then
    echo "assert-npm-pack: required file missing from tarball: $r" >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "assert-npm-pack: $violations violation(s) found" >&2
  echo "Full file list:" >&2
  echo "$files" >&2
  exit 1
fi
exit 0
