import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests touch the real ~/.claude/.do-not-touch-sentinel file
    // (one shared path on the founder's machine). The sentinel-leak test in
    // test/harness/harness.test.ts deliberately mutates that file to prove
    // the guard catches what it exists for; running other integration tests
    // in parallel would observe the mid-mutation state and false-positive.
    // Serial file execution keeps the sentinel guard reliable.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
