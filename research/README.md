# research/

Throwaway probes for the claudemux v0.0.1 pre-build research sprint. The
durable outputs of this sprint are `findings.md`, the two CI canaries under
`.github/workflows/`, and the JSON fixture under `fixtures/`. Everything in
`harness/` is scaffolding for re-running a probe; it is not production code.

## How to re-run any probe from this directory

```bash
# From the repo root, once per machine:
bash research/harness/backup.sh

# Then for any probe (here, a no-op smoke):
source research/harness/harness.sh
probe_run my-probe-id -- bash -c 'tmux -L "$TMUX_SOCKET" new-session -d "true"'
bash research/harness/teardown.sh
```

Inside any `probe_run`, the env is `env -i`'d down to a sandbox HOME, the
XDG_* paths under that HOME, the private `TMUX_SOCKET`, a UTF-8 locale,
and a stable PATH. The founder's real `~/.claude/` is protected by the
`~/.claude/.do-not-touch-sentinel` mtime check that runs after every probe.

Run log lives at `research/run-log.jsonl`. One JSONL row per `probe_run`
invocation: `{ts, item, cmd, exit, output_hash, tmux_version, os}`. No
captured stdout content is persisted there — only the sha256 of it — so
the log is safe to commit.

## Layout

| Path | Purpose |
|---|---|
| `findings.md` | The primary artifact. Nine sections, each ending in `**Decision:** X`. |
| `harness/harness.sh` | Sourced by every probe. Exports the sandbox env + `probe_run`. |
| `harness/backup.sh` | Idempotent. Backup + sentinel install. Run once per machine. |
| `harness/verify-sentinel.sh` | Asserts the sentinel mtime hasn't moved. Called by every probe. |
| `harness/teardown.sh` | Best-effort cleanup of the private tmux server + sandbox HOME. |
| `harness/smoke.sh` | End-to-end check of the harness contract. |
| `fixtures/permission-prompt-classifier-fixture.json` | Item 4's enumeration of pane-text patterns. |
| `fixtures/permission-prompts.test.ts` | CI test that replays each fixture scenario. |
| `fixtures/validate-fixture.ts` | Schema validator for the fixture. |
| `run-log.jsonl` | Per-probe audit trail. |

## Rollback

If something goes wrong, the pre-research tarball is at
`~/claude-bak-<unix>.tgz`. To restore:

```bash
tar xzf ~/claude-bak-<unix>.tgz -C ~
```

## Safety: kill only PIDs the probe itself spawned

Any probe that kills processes (item 6's pane-death enumeration is the
obvious one) MUST kill by **exact PID** captured at spawn time, not by
process name or `pkill`-style pattern matching. The Linux user this
sandbox runs under is also called `claude`, and the founder may have
a live Claude Code session in another terminal. A `pkill claude` or
`pgrep -f /home/claude/.local/bin/claude | xargs kill` will hit that
session and crash work in progress.

Convention for spawn-then-kill probes:

```bash
claude ... &        # spawn under the sandbox
spawned_pid=$!      # record the PID immediately
# ... do the probe ...
kill -9 "$spawned_pid" 2>/dev/null   # ONLY this PID, by number
```

For process-group orphan enumeration (item 6's `setsid` case), kill by
`-<pgid>` only after capturing the pgid from the probe's own spawn —
again, never by name.
