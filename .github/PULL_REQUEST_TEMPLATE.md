<!-- Thanks for contributing. Keep PRs small and single-purpose. -->

## What & why

What does this change, and what problem does it solve? Link the issue it
closes (`Closes #123`).

## Scope

claudemux reports observable session **state**; the consumer owns **policy**.

- [ ] This is mechanism, not policy (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
- [ ] The public surface stays backend-neutral — no tmux (or other backend)
      vocabulary leaks into types, errors, or `--help`.

## Checklist

- [ ] `npm run check` passes (Biome).
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (unit + integration).
- [ ] The CI guards pass: `scripts/layering-grep.sh`, `scripts/no-tmux-in-public.sh`,
      `scripts/safety-grep.sh`, `scripts/assert-npm-pack.sh`.
- [ ] New/changed behavior is covered by tests.
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (additive vs. breaking noted).
- [ ] Docs/README updated if the public surface changed.

## Notes for reviewers

Anything non-obvious — design trade-offs, things you're unsure about, follow-ups
deferred.
