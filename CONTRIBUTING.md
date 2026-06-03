# Contributing to claudemux

Thanks for your interest. claudemux is a small, deliberately-scoped substrate —
it drives long-lived real-login Claude Code sessions and owns no configuration
of its own. Contributions are welcome; the bar is high and the surface is
intentionally narrow. Reading this first will save us both a round-trip.

## Scope — what claudemux is (and isn't)

claudemux reports observable session **state**; the consumer owns **policy**.
That line governs every design call (it's written up in
[`docs/decisions/`](./docs/decisions)). Before proposing a feature, check it
against that boundary:

- **In scope:** mechanism — verbs that do exactly one observable thing
  (`send`, `wait`, `interrupt`), state the substrate can detect from the pane,
  backend-neutral typed errors.
- **Out of scope:** policy — retry/patience timeouts, watchdog logic, anything
  that hardcodes a consumer's judgment; injected-credential / API-key automation
  (that's the Claude Agent SDK's job — see the README §1 "what this is *not*
  for"); Windows-native (tmux is Unix-only; WSL is community territory,
  undocumented by the maintainers).

If you're unsure whether an idea fits, **open an issue before writing code.** A
rejected PR is a worse outcome for everyone than a five-minute scoping comment.

## Development setup

Requires **Node ≥ 20**, **tmux ≥ 3.2**, and a working `claude` CLI on `PATH`
(authenticated once interactively — the integration tests drive the real
binary).

```sh
git clone https://github.com/wastedcode/claudemux.git
cd claudemux
npm ci
npm run build
```

## The local gate (run this before every PR)

CI runs two lanes — cheap structural `gates`, then a `tmux 3.2/3.4/3.5a ×
{ubuntu, macos}` test matrix. Reproduce the structural lane locally:

```sh
npm run check        # biome lint + format check
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.build.json
npm test             # vitest — unit (src/) + integration (test/)

# the four CI guard scripts — these enforce architectural invariants:
bash scripts/safety-grep.sh .        # no peer-process-by-name kills; every tmux call carries -f /dev/null
bash scripts/layering-grep.sh .      # backends/ ⊥ agents/; no claude strings in backends, no tmux strings in agents
bash scripts/no-tmux-in-public.sh .  # zero "tmux" in the public surface (index/types/errors/--help)
bash scripts/assert-npm-pack.sh .    # the published tarball matches the allow-list exactly (no brain/, no fixtures)
```

A PR that fails any of these will not pass CI. They encode non-negotiable
promises: the backend-neutral public API, the seam discipline that lets a future
backend slot in without consumer rewrites, and the guarantee that we never kill
a peer `claude` REPL or read your `~/.tmux.conf`.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`). Keep them small and grounded — a commit body should say
  *why*, and claims about runtime behavior should be verified against a real
  `claude`, not assumed.
- **Public API changes are additive by default.** Optional → required is the
  only non-breaking tightening direction. A breaking change needs a strong
  rationale and a CHANGELOG `### Changed`/`### Removed` entry.
- **Typed errors** extend `ClaudemuxError` and carry an actionable,
  backend-neutral message. The backend's vocabulary must never leak into a
  public error (CI greps for this).
- **Tests:** unit tests live next to source under `src/`; integration tests that
  drive real tmux live under `test/`. New behavior needs coverage; new claude
  render-matching needs a fixture under `test/fixtures/`.
- **CHANGELOG:** user-facing changes go under `## [Unreleased]` in
  [`CHANGELOG.md`](./CHANGELOG.md) (Keep a Changelog format).

## Pull requests

1. Branch from `main`.
2. Make the change; run the full local gate above.
3. Open the PR against `main` with the template filled in. Describe the *why*,
   and how you verified runtime behavior (especially against authenticated
   claude, if relevant).
4. CI must be green. A maintainer will review.

## Reporting bugs & security issues

Functional bugs: open a [bug report](https://github.com/wastedcode/claudemux/issues/new/choose).
**Security vulnerabilities: do not open a public issue** — follow
[`SECURITY.md`](./SECURITY.md).

By contributing, you agree your contributions are licensed under the project's
[MIT License](./LICENSE).
