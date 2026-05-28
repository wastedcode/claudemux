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

describe("CLI error messages — concurrent spawn race (QA P1-R2)", () => {
  it("two concurrent spawns of the same name: neither stderr leaks 'tmux', loser gets SessionExists", async () => {
    // The shared default socket (ADR 0006) makes concurrent same-name
    // spawns routine. The TOCTOU window between create()'s exists-check
    // and backend.spawn() means tmux — not the substrate — sometimes
    // discovers the collision and emits `duplicate session: …`. That must
    // surface as SessionExists, clean of any 'tmux' vocabulary.
    //
    // Both processes boot real claude in a fresh sandbox HOME, so each
    // will EITHER lose the spawn race (SessionExists) OR win the spawn and
    // then hit LoginRequired at boot (claude isn't authenticated). Both are
    // clean typed errors. The invariant under test: NEITHER stderr contains
    // 'tmux', and at least one carries "session already exists".
    const path = `/home/claude/.local/bin:${h.env.PATH}`;
    const run = () =>
      new Promise<CliResult>((resolve, reject) => {
        const env = { ...h.env, CLAUDEMUX_SOCKET: testSocket, PATH: path };
        const child = spawn(
          binPath,
          ["spawn", "race", "--cwd", h.sandbox.home, "--boot-timeout-ms", "3000"],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
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

    const [a, b] = await Promise.all([run(), run()]);

    // Core invariant: no 'tmux' vocabulary leaks from either process.
    expect(a.stderr.toLowerCase(), `process A stderr leaked tmux:\n${a.stderr}`).not.toContain(
      "tmux",
    );
    expect(b.stderr.toLowerCase(), `process B stderr leaked tmux:\n${b.stderr}`).not.toContain(
      "tmux",
    );

    // Both failed (one on the race, one on LoginRequired — or both on the
    // race if neither got far enough to boot). Both exit non-zero.
    expect(a.exit).not.toBe(0);
    expect(b.exit).not.toBe(0);

    // At least one process should have hit the duplicate-session race and
    // surfaced SessionExists. (If the race resolved at the exists-check it
    // also says "session already exists"; if it resolved at tmux level the
    // duplicate-session classifier produces the same message.)
    const combined = `${a.stderr}\n${b.stderr}`;
    expect(combined).toContain("session already exists");
  }, 30_000);
});
