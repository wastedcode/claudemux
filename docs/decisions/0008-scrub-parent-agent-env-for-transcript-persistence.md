# 0008. Scrub the parent agent's env so the spawned `claude` persists its transcript

**Status:** accepted
**Date:** 2026-06-09

## Context

claudemux **drives** a spawned `claude` by reading the agent's on-disk transcript JSONL
(`~/.claude/projects/<slug>/<session-id>.jsonl`). `messagesSince`, `turnComplete`, and the gating that
sits on top of them all read that file (the `AgentDef.transcript.*` channel in `src/agents/claude.ts`).
A spawned agent whose transcript never lands on disk is, by claudemux's core invariant, **broken** —
the substrate has nothing to observe.

We root-caused (A/B, today) a recurring "0 messages / gate stalls" failure to claude's own
**nested-session detection**. When the spawned `claude` *inherits* the parent Claude Code's environment
— `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `AI_AGENT`
— claude concludes it is running *inside* another agent and **suppresses its own transcript
persistence**: it writes only an async `ai-title` record, with zero `user`/`assistant`/`system` records
on disk. The turn runs and renders in the pane, but claudemux's transcript reads come back empty. This
fires whenever claudemux is operated from inside a Claude Code session — interactive dev, CI under a
Claude runner, and nested agents — i.e. exactly the development and automation contexts the project
runs in. It is **not** a claude-version regression (2.1.168 and 2.1.169 behave identically) and **not**
a flush-timing race.

The proven fix is to launch claude with those variables genuinely **unset** for the pane process.
A/B-validated: an identical spawn prefixed with
`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_EXECPATH -u AI_AGENT claude --session-id …`
restores the full transcript (10 records including user/assistant/system/bridge-session). Unsetting any
**single** variable did not restore persistence — the detection trips on any remaining signal, so the
**whole set** must go.

Two mechanical realities constrain the fix:

1. **The existing env channel is set-only.** `buildArgv` returns `env`, threaded via `spawn-boot.ts`'s
   `mergedEnv` into `newSession` (`src/backends/tmux/sessions.ts`), which emits `tmux new-session -e
   KEY=VAL`. tmux `-e` can **set** but never **unset**. Blanking with `-e VAR=` leaves the variable
   *present but empty*; claude's heuristic presence-checks several of these, so a blank is unreliable.
   A **true unset** is required.
2. **The tmux server is shared and persistent** (`/tmp/tmux-$UID/claudemux`, ADR 0006; `exec.ts` spawns
   tmux with `env: process.env`). The *first* process to start the server bakes *its* `process.env` into
   the server globally for the server's lifetime. So mutating `process.env` before spawn is a no-op when
   the server was already started from a nested (CLAUDECODE=1) shell. The scrub must therefore act at the
   **pane/exec layer** — on the command that launches the pane process — not via `process.env` and not
   via a server-global.

Product framing (decided upstream, designed within here): the scrub is **unconditional by default** — no
persona legitimately wants a suppressed-transcript agent. We add **no new flag** (`--keep-parent-env` was
rejected). The escape hatch is the *existing* `env`/`extraArgs` passthrough, the same shape as the
existing `hooks: false` opt-out and the "mechanism-not-policy / claudemux-owns-no-config" principles
(ADR 0006): a deliberate `create({ env: { CLAUDECODE: "1" } })` re-set must **win** over the scrub.

By the T12 layering-grep rule, the claude-specific variable **list** and the decision to scrub belong in
`src/agents/claude.ts` — the only file permitted to know claude's vocabulary (verified: the
`SESSION_ID_FLAG`/transcript/hook vocabulary all live there, grep-enforced by
`scripts/layering-grep.sh`).

## Decision

1. **Add an explicit `unsetEnv?: string[]` to the agent `buildArgv` contract**, threaded
   `buildArgv → SpawnBootInput → Backend.spawn → newSession`, and emitted by the tmux backend as a real
   unset. `claude.ts` returns
   `unsetEnv: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EXECPATH", "AI_AGENT"]`
   on every fresh **and** resume/fork spawn (the suppression is path-independent). `cmd` stays `"claude"`
   and `argv` stays `["--session-id", "<id>", …]` — both unchanged.

2. **The tmux backend emits the unset as an `env -u …` pane-command prefix**, not via `-e`. `newSession`
   builds the pane command as
   `env <-u NAME …per unsetEnv> -- <cmd> <argv…>` while keeping the existing `-e KEY=VAL` flags for the
   *set* env. Rationale, mirroring the existing `-e`-not-`set-environment` comment in `sessions.ts`:
   `set-environment -u -t <target>` mutates the session's env *after* the pane process has already been
   spawned, so it cannot affect that process; and `-e VAR=` cannot truly unset. Wrapping the launch
   command in coreutils/BSD `env -u` is the only mechanism that produces a genuinely-absent variable in
   the pane process, and it is immune to the baked-server trap because it acts at exec time on the pane
   command itself, not on any server/global env.

3. **Precedence: unset is applied BEFORE the explicit `env` merge wins.** The pane command must read as
   "unset these, then set those," so a key named by *both* `unsetEnv` and the merged `env` ends up
   **set** (the consumer's re-set wins). Concretely, the `-u NAME` for a key that also appears in the
   `-e KEY=VAL` set is dropped at emission, so `env` never both unsets and re-sets the same name and the
   re-set is unambiguous. `LC_ALL` (claude's existing set-env) is untouched.

4. **The list lives only in `claude.ts`.** Neither the variable names nor `"env"`/`-u` semantics encode
   any claude knowledge in `src/backends/**` — the backend receives an opaque `string[]` of names to
   unset and knows nothing about why. This respects the layering grep: `claude.ts` owns the *what*, the
   backend owns the *how* (the `env -u` mechanism), `unsetEnv` is the neutral seam between them.

### Rejected: have `claude.ts` return a wrapped argv (`cmd: "env", argv: ["-u", …, "claude", …]`)

This was the tempting one-file change. Rejected because it defeats invariants the substrate already
enforces and tests already pin:

- **It breaks the documented `cmd: "claude"` expectation** and the argv shape. `create-identity.test.ts`
  asserts `claude.buildArgv({ sessionId }).argv` deep-equals `["--session-id", id]` and that
  `--session-id` and its value are **two adjacent argv elements** — a *security invariant* (every element
  reaches the backend verbatim with no shell, so a value can never be re-parsed as a flag or, in tmux's
  argv grammar, a second command). Folding `env -u … claude` into `argv` pushes the real command and its
  flags deep into a positional list and shifts the `--session-id` adjacency the tests and the security
  argument depend on.
- **It leaks the `env` launcher into the neutral identity contract.** `cmd` means "the agent binary."
  Making it sometimes `"env"` forces every consumer of `buildArgv`'s return (and `adopt`/observability,
  which surface `cmd`) to special-case a wrapper. `unsetEnv` keeps `cmd` honest.
- **It puts a process-launcher (`env`) where the agent should only describe itself.** The mechanism of
  *how* a variable gets unset for a pane is a substrate/backend concern; `claude.ts` should declare the
  *names*, not choose the launcher binary or its flag grammar.

`unsetEnv` costs one optional field on a contract we already thread, and changes one `newSession` command
assembly. It keeps the irreversible surface — the public `buildArgv` return shape — additive and
backward-compatible (the field is optional; agents and backends that ignore it are unaffected).

## Consequences

- **The transcript channel works from inside a Claude Code session** — dev, CI, and nested agents — which
  is the substrate's core read path. The gremlin ("0 messages / gate stalls") is closed at its root, not
  papered over with flush retries.
- **`env -u` of a not-present variable is a harmless no-op**, by both GNU coreutils and BSD/macOS `env`:
  `-u NAME` removes `NAME` if present and is silent if not. So scrubbing the full set is safe even when
  claudemux is run from a *clean* (non-nested) shell where some or all of the variables are absent — no
  conditional "only unset what's present" logic is needed, and the behavior is identical across the
  Linux/macOS support matrix.
- **`env` must be on PATH and support `-u`.** `env` is mandated by POSIX and present on every platform
  the project supports; `-u` is supported by both GNU coreutils and BSD `env`. We invoke it **unqualified**
  (`env`, resolved on the pane's PATH) consistent with how the backend already invokes `tmux`. The pane
  runs under the substrate's PATH; if `env` were somehow absent the pane command fails loudly at spawn
  (a visible boot failure), never a silent transcript-suppression — fail-loud over fail-silent.
- **The baked-server trap is structurally avoided.** Because the scrub is part of the pane command, it is
  correct whether the shared tmux server was first started from a nested or a clean context. A
  `process.env`-mutation fix or an `-e VAR=` blank fix would both pass in a clean dev run and silently
  regress under a server first booted from CLAUDECODE=1 — which is precisely why the regression test
  (below) must boot the server from a nested context first.
- **Resume / fork paths are covered.** The suppression is about the *spawned* process's inherited env,
  independent of `--session-id` vs `--resume`/`--fork-session`, so `unsetEnv` is returned on every
  `buildArgv` path. A resumed/forked claude that re-reads history still needs to *persist* the continuing
  conversation; without the scrub it would suppress just as a fresh session does.
- **Scrubbing `CLAUDE_CODE_SESSION_ID` does not break claudemux.** claudemux never reads the parent's
  `CLAUDE_CODE_SESSION_ID`; it mints/owns its own conversation id and passes it as `--session-id`
  (`src/session/create.ts` → `claude.ts`). The scrubbed variables are the *parent* agent's identity, of
  which the spawned child must be ignorant — that ignorance is the fix.
- **The consumer escape hatch is real and precedence-correct.** A consumer who genuinely wants the nested
  behavior re-sets the variable via `create({ env: { CLAUDECODE: "1" } })`; because the set merge wins
  over the unset (Decision 3), their value survives. No new flag, no new policy surface — the same opt-out
  shape as `hooks: false`.
- **Idempotency / ordering is defined for the unset∩set overlap.** When a key appears in both `unsetEnv`
  and the merged `env`, the backend drops the `-u` and emits only the `-e KEY=VAL`. This makes the
  `env` invocation deterministic regardless of argument order and encodes "explicit set wins" mechanically
  rather than relying on `env`'s left-to-right evaluation.
- **Layering stays intact.** The variable names and the scrub decision are confined to `claude.ts`; the
  backend gains only a generic `unsetEnv: string[]` → `env -u` capability with no claude vocabulary. The
  layering grep's banned-string sets are unaffected (the names are not tmux command names and live in the
  permitted file).
- **Cost of the wrong fix, named.** A blank-via-`-e` or `process.env`-only fix is *cheaper to write* and
  *passes a naive happy-path test*, then silently fails in CI/nested operation — the highest-cost outcome
  (an intermittent, environment-dependent data-loss bug). The `env -u` pane-prefix is the more expensive
  build by a small margin and the only one that survives the shared-server reality; the regression test
  is what holds the line.

## Evidence

Verified against the code at HEAD. The set-only env path: `buildArgv` returns `env`
(`src/agents/claude.ts`), merged in `spawnBootHandle` as `mergedEnv` (`src/session/spawn-boot.ts`) and
emitted as `new-session -e KEY=VAL` (`src/backends/tmux/sessions.ts`), whose own comment already records
why `set-environment` after `new-session` cannot affect the spawned pane. The shared/persistent server
and its baked `env: process.env` are in `src/backends/tmux/exec.ts` + `socket.ts` (ADR 0006). The
`cmd: "claude"` / two-adjacent-element `--session-id` invariant is pinned by
`test/session/create-identity.test.ts`. The claude-vocabulary-only-in-`claude.ts` rule is enforced by
`scripts/layering-grep.sh` (meta-tested in `test/scripts/safety-grep.test.ts`). The fix mechanism (full
five-variable `env -u` prefix restoring a 10-record transcript; single-variable unset insufficient) was
A/B-validated on 2026-06-09 against claude 2.1.168/2.1.169.

## Follow-up (2026-06-09): validate `unsetEnv` names at the backend boundary

A security review of the shipped scrub accepted, named, and deemed **non-blocking** a defense-in-depth
gap in Decision-4's seam. This follow-up **refines, and does not reverse, that decision** — which is why
it is recorded here rather than as a superseding ADR: no accepted decision changes, the public
`buildArgv`/`unsetEnv` contract is untouched, and `unsetEnv` stays a neutral `string[]` the backend
"knows nothing about." It is purely additive hardening of the same seam.

**The gap.** Decision 4 makes the backend receive an **opaque `string[]`** of names — correct for
*layering*, but it means the backend performs **no shape validation** of the names it splices into the
`env -u NAME …` pane prefix. Today the **sole producer** is the trusted constant `NESTED_AGENT_ENV` in
`claude.ts`, so there is **no exploit**. The gap is latent: if a future agent (or a direct
`tmuxBackend.spawn` consumer) ever derived `unsetEnv` from untrusted input, a name like `"-X"`, `""`, or
one containing `=`/whitespace could **mis-instruct `env`**. It stays a single argv element — no shell, so
**no shell-escape and no second-command** risk (the `--` terminator and the no-shell `execFile` path both
hold) — but a crafted name could make `env` set/misparse a variable or consume the next token as a flag
for that one spawn.

**Why the boundary, not `claude.ts`.** The check asserts that each name is a **well-formed POSIX
environment-variable name** — a property of the *seam's own grammar* (what `env -u` can safely accept),
**not** claude knowledge. So it belongs at the boundary, runs for **any** producer (defense at the seam,
not trust in the agent), and keeps the layering grep clean. It mirrors exactly where `validateNamePart`
is already called on the same `spawn` method.

**Decision (follow-up):**

1. **A neutral validator `validateEnvVarName(name: string): void`** in `src/session/validate.ts`,
   alongside `validateNamePart` / `validateAgentSessionId` (this file is the substrate's boundary-validator
   home; the backend already imports `validateNamePart` from here). It enforces the POSIX
   portable-name shape **`/^[A-Za-z_][A-Za-z0-9_]*$/`** — anchored, so it rejects the empty string, a
   leading `-` (the `env`-flag hazard), and any name containing `=`, whitespace, or a control char (all
   structurally excluded by the character class; `=` and `-` need no separate check because the anchored
   regex already forbids them). This is the **stricter** sibling of `validateNamePart`: an env name is a
   pure identifier, so an allow-list regex is simpler and tighter than the deny-list used for tmux target
   names. The trusted `NESTED_AGENT_ENV` set (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `AI_AGENT`) **all match**, so no existing caller breaks.

2. **Enforced at the tmux backend boundary** in `tmuxBackend.spawn` (`src/backends/tmux/index.ts`),
   beside the existing `validateNamePart` calls. It runs for **any** `unsetEnv` reaching the backend
   regardless of producer, only on `spawn` (the sole mutating verb that carries `unsetEnv`), and
   **before** `newSession` — so it composes cleanly with the existing unset∩set overlap filter
   (validation gates the *names*; the overlap filter decides set-vs-unset *precedence* — orthogonal).
   O(n) over a ≤5-element list on the cold spawn path — negligible.

3. **A new typed error `InvalidEnvVarName extends ClaudemuxError`** in `src/errors.ts`, matching the
   `InvalidAgentSessionId` shape (carries the offending `value`; `sessionName` placeholder
   `"<invalid-unsetEnv>"` since no session is created). It fails **closed** — thrown synchronously inside
   the `async spawn`, surfacing as a promise rejection before any tmux invocation, consistent with how
   `validateNamePart`'s throw is surfaced. No bare `Error`, per the taxonomy's contract.

This is purely additive and backward-compatible: the validator only *rejects* malformed names that the
sole current producer never emits — a no-op for every shipping path, a guard for every future one.
