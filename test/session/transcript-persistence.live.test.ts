import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmuxBackend } from "../../src/backends/tmux/index.js";
import { mintSocket } from "../../src/backends/tmux/socket.js";
import type { Backend } from "../../src/backends/types.js";
import { create } from "../../src/session/create.js";
import type { SessionHandle } from "../../src/types.js";

/**
 * Live regression for the parent-agent env scrub (ADR 0008).
 *
 * The bug: a `claude` spawned by claudemux that inherits the parent Claude
 * Code's env (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_EXECPATH`, `AI_AGENT`) can trip claude's nested-session detection
 * and SUPPRESS its own transcript persistence — leaving claudemux, which drives
 * the agent by READING that transcript, with an empty conversation. The fix
 * launches the pane under an `env -u <all five> --` prefix so those vars are
 * genuinely ABSENT from the claude process.
 *
 * Why this test asserts the SCRUB, not claude's suppression behaviour:
 * claude's nested-detection is an opaque, version- and environment-fragile
 * heuristic. An on-box A/B (2026-06-09, claude 2.1.168/2.1.169/2.1.170) found
 * the SAME binary both suppresses and persists depending on which *other* env
 * vars happen to be present alongside `CLAUDECODE` (e.g. a node/npm launch
 * context flips it). So a behavioural assertion — "did claude suppress?" — is
 * non-deterministic and would be a false-confidence guard (it passes even with
 * the fix reverted, under a non-suppressing env). The deterministic,
 * version-independent regression is the fix's OWN observable effect: under a
 * tmux server whose global env carries all five nested vars (tmux seeds a
 * server's global env from the process that starts it and copies it into every
 * later pane — `update-environment` would NOT propagate these, so baking at
 * server-start is the faithful repro), a claudemux-spawned claude process must
 * have all five vars SCRUBBED. That absence is the necessary-and-sufficient
 * cause of correct persistence; reverting the `env -u` emission makes all five
 * leak into the pane (verified), so this is a real regression guard.
 *
 * Like the other `*.live.test.ts`, this spawns a real authenticated claude, so
 * it is excluded from the gate suite (`vitest.config.ts`) AND self-skips unless
 * `CLAUDEMUX_LIVE_TRANSCRIPT_PERSISTENCE=1`. It never runs in CI — it is a
 * maintainer acceptance test for the ADR 0008 fix. It reads the pane process's
 * environment via `/proc`, so it also self-skips on non-Linux.
 */
const LIVE = process.env.CLAUDEMUX_LIVE_TRANSCRIPT_PERSISTENCE === "1";
const HAVE_PROC = process.platform === "linux";

/**
 * The five parent-agent env vars that claudemux must scrub (ADR 0008).
 * Deliberately duplicated here rather than imported from `src/agents/claude.ts`:
 * the test pins the OBSERVED set independently of the production constant — if
 * they drift, that is a finding, not a silently-passing test. Values are
 * realistic-but-inert; only their presence/absence in the pane matters.
 */
const NESTED_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "AI_AGENT",
] as const;
const NESTED_ENV: Record<string, string> = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000000",
  CLAUDE_CODE_EXECPATH: "/nonexistent/claude-parent",
  AI_AGENT: "claude-code_test_agent",
};

/**
 * Boot the tmux server on `socket` with the nested env baked into its global
 * environment, then leave a holder session so the server stays up. Matches the
 * backend's `-L <socket> -f /dev/null` form so `tmuxBackend({ socket })`
 * attaches to THIS server and its later panes inherit the nested global env.
 */
function bootNestedServer(socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tmux",
      // biome-ignore format: argv reads clearer one-per-line
      [
        "-L", socket, "-f", "/dev/null",
        "new-session", "-d", "-s", "nested-boot-holder",
        "sleep", "100000",
      ],
      { env: { ...process.env, ...NESTED_ENV }, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`nested-server boot exited ${code}`)),
    );
  });
}

/** SIGKILL-free server teardown: `kill-server` reaps the holder + every pane. */
function killServer(socket: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("tmux", ["-L", socket, "-f", "/dev/null", "kill-server"], {
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/** The foreground pane process pid for a tmux session target. */
function panePid(socket: string, target: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      "tmux",
      ["-L", socket, "-f", "/dev/null", "list-panes", "-t", target, "-F", "#{pane_pid}"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.on("close", () => resolve(out.trim()));
  });
}

/** The env var NAMES of a live process, read from `/proc/<pid>/environ`. */
function processEnvNames(pid: string): Set<string> {
  const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
  return new Set(raw.split("\0").map((entry) => entry.split("=")[0] ?? ""));
}

describe("parent-agent env scrub on a nested-booted shared server (ADR 0008)", () => {
  if (!LIVE || !HAVE_PROC) {
    const why = !LIVE
      ? "set CLAUDEMUX_LIVE_TRANSCRIPT_PERSISTENCE=1 to enable (maintainer acceptance test)"
      : "requires Linux /proc to read the pane process environment";
    it.skip(`auth-gated — ${why}`, () => {});
    return;
  }

  let socket: string;
  let backend: Backend;
  let cwd: string;
  const sessions: SessionHandle[] = [];

  beforeAll(async () => {
    socket = mintSocket();
    await bootNestedServer(socket);
    backend = tmuxBackend({ socket });
    cwd = mkdtempSync(join(tmpdir(), "claudemux-scrub-live-"));
  });

  afterAll(async () => {
    for (const s of sessions) await s.kill().catch(() => undefined);
    await killServer(socket);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("a claudemux-spawned claude has all five nested-agent vars scrubbed from its process env", async () => {
    const session = await create({ name: "scrub-1", cwd, backend, trustWorkspace: true });
    sessions.push(session);

    const pid = await panePid(socket, `${session.namespace}--${session.name}`);
    expect(pid).toMatch(/^\d+$/); // a real pane process, not an empty target

    const names = processEnvNames(pid);
    const leaked = NESTED_VARS.filter((v) => names.has(v));

    // The load-bearing assertion: the fix (`env -u … --`) removed every nested
    // var from the live claude process. Reverting the emission leaks all five
    // (the negative control), which is what would re-suppress the transcript.
    expect(leaked).toEqual([]);

    // Sanity: the holder pane DID carry the nested env, proving the server
    // global env is the suppressing source the scrub had to defeat (not a
    // vacuously-clean environment).
    const holderPid = await panePid(socket, "nested-boot-holder");
    expect(processEnvNames(holderPid).has("CLAUDECODE")).toBe(true);
  }, 120_000);
});
