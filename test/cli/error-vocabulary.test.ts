import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintSocket } from "../../src/backends/tmux/socket.js";
import { Harness } from "../harness/index.js";

/**
 * QA P1-2 regression test — the substrate's success-criteria #3 says
 * error messages MUST NOT contain "tmux" (or the substrate's backend
 * argv). Previously, `wait`/`state`/`capture` against a missing session
 * surfaced a `BackendError` whose `.message` included
 * `tmux capture-pane -p -t …` verbatim.
 *
 * This file drives `bin/claudemux` as a subprocess against an empty
 * socket (server not running) and asserts no error path leaks the word
 * "tmux" into the user-visible stderr.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const binPath = join(repoRoot, "bin", "claudemux");

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

let h: Harness;
let testSocket: string;

beforeEach(() => {
  h = Harness.create();
  testSocket = mintSocket();
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...h.env, CLAUDEMUX_SOCKET: testSocket };
    const child = spawn(binPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => resolve({ exit: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("CLI error messages — no `tmux` leakage on common error paths", () => {
  it("`claudemux wait <missing>` does not leak 'tmux' into stderr", async () => {
    const r = await runCli(["wait", "no-such-session", "--timeout-ms", "500"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain("tmux");
  });

  it("`claudemux state <missing>` does not leak 'tmux' into stderr", async () => {
    const r = await runCli(["state", "no-such-session"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain("tmux");
  });

  it("`claudemux capture <missing>` does not leak 'tmux' into stderr", async () => {
    const r = await runCli(["capture", "no-such-session"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain("tmux");
  });

  it("`claudemux send <missing>` does not leak 'tmux' into stderr", async () => {
    const r = await runCli(["send", "no-such-session", "hi"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain("tmux");
  });

  it("error stderr DOES carry the namespaced session label (so users can diagnose)", async () => {
    const r = await runCli(["wait", "diag-probe", "--timeout-ms", "500"]);
    expect(r.exit).not.toBe(0);
    // The label format is `claudemux/diag-probe` — keeps the user oriented.
    expect(r.stderr).toContain("claudemux/diag-probe");
  });
});
