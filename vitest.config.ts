import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The permission-prompt replay test spawns a REAL authenticated claude and
    // replays untrusted pane-text scenarios against it. It must run only under
    // a dedicated network-isolated (`--network=none`) workflow — its original
    // workflow was retired in the Path-B simplification (ADR 0010) and is
    // re-introduced in v0.1. It is kept out of the general suite / required-check
    // gate here so no stray `CLAUDEMUX_LIVE_PERMISSION_PROMPTS=1` can fire
    // un-isolated live claude in the gatekeeper path. See the file header.
    exclude: [
      ...configDefaults.exclude,
      "test/fixtures/permission-prompts.test.ts",
      // interrupt.live.test.ts spawns a REAL authenticated claude (gated by
      // CLAUDEMUX_LIVE_INTERRUPT=1) — same reason as the permission-prompts
      // replay: keep live claude out of the gatekeeper path; it runs only under
      // the dedicated network-isolated live workflow.
      "test/session/interrupt.live.test.ts",
      // agent-session-id.live.test.ts spawns a REAL authenticated claude (gated
      // by CLAUDEMUX_LIVE_AGENT_SESSION_ID=1) to prove the id round-trip,
      // resume-via-extraArgs, and the collision error — same isolation reason.
      "test/session/agent-session-id.live.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests touch the real ~/.claude/.do-not-touch-sentinel file
    // (one shared path on the founder's machine). The sentinel-leak test in
    // test/harness/harness.test.ts deliberately mutates that file to prove
    // the guard catches what it exists for; running other integration tests
    // in parallel would observe the mid-mutation state and false-positive.
    // Serial file execution keeps the sentinel guard reliable. `fileParallelism:
    // false` is the load-bearing setting (no two files run at once); `maxWorkers:
    // 1` pins a single worker. Vitest 4 removed `poolOptions.forks.singleFork` in
    // favor of these top-level options (migration: pool-rework).
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
