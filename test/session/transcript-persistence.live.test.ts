import { describe, it } from "vitest";

/**
 * Live regression for the parent-agent env scrub (ADR 0008) — the SHARP one.
 *
 * Root cause: a `claude` spawned by claudemux that INHERITS the parent Claude
 * Code's env (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_EXECPATH`, `AI_AGENT`) trips claude's nested-session detection
 * and SUPPRESSES its own transcript persistence — only an async `ai-title`
 * record lands, with zero user/assistant/system records. claudemux drives the
 * agent by READING that transcript, so a suppressed agent is broken. The fix
 * launches the pane under an `env -u <all five> --` prefix.
 *
 * Why this test is the sharp one (ADR 0008 §Consequences): the bug only
 * reproduces when the SHARED, persistent tmux server (`/tmp/tmux-$UID/…`, ADR
 * 0006) was FIRST started from a nested (CLAUDECODE=1) context — that bakes the
 * nested env into the server globally for its lifetime, so a `process.env`-only
 * or `-e VAR=`-blank fix would pass a clean dev run yet silently regress here.
 * A faithful regression must therefore:
 *   1. start the shared tmux server from a CLAUDECODE=1 (et al.) process.env;
 *   2. `create()` a real authenticated claude on THAT server;
 *   3. run one turn and assert the on-disk transcript contains real
 *      user/assistant/system records — not merely an `ai-title` record.
 *
 * STATUS: left as a skipped placeholder. The live harness (`test/harness`,
 * `CLAUDEMUX_LIVE_*` gating) is `env -i`-equivalent — it builds a curated env
 * WITHOUT `process.env`, and the existing live tests call `create()` against
 * the default backend/socket. Faithfully reproducing the baked-server trap
 * needs new harness scaffolding the current infra does not provide:
 *   - a way to first-boot the shared server from a controlled CLAUDECODE=1
 *     process.env (the curated env deliberately omits it), distinct from the
 *     pane spawn; and
 *   - a transcript-record-TYPE assertion (user/assistant present, not just
 *     ai-title) — today's live tests assert only that the transcript file
 *     EXISTS, which the suppressed-ai-title case would also satisfy.
 * Per the engineer brief, this is left as a clearly-marked skipped test rather
 * than half-built harness infra. See ADR 0008 §Evidence for the A/B proof
 * (full five-variable `env -u` prefix restores a 10-record transcript;
 * single-variable unset insufficient) the harness work would re-pin in CI.
 */
describe("transcript persistence under a nested-booted shared server (ADR 0008)", () => {
  it.skip("scrubbing the parent-agent env restores user/assistant transcript records (needs harness scaffolding — see file header + ADR 0008)", () => {});
});
