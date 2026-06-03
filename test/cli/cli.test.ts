import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, claudeBinDir } from "../harness/index.js";

/**
 * CLI integration test. Spawns `bin/claudemux` as a subprocess so we
 * exercise the actual entry point + commander wiring, not just the
 * function-level handlers.
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

beforeEach(() => {
  h = Harness.create();
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

/** Run the CLI binary with a curated env so it shares the harness's sandbox HOME. */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...h.env, ...extraEnv };
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

describe("CLI — bin/claudemux exists and is runnable", () => {
  it("the bin entry point exists and is executable", () => {
    expect(existsSync(binPath)).toBe(true);
  });

  it("--help works and contains the 9 verb names", async () => {
    const r = await runCli(["--help"]);
    expect(r.exit).toBe(0);
    for (const verb of [
      "spawn",
      "send",
      "interrupt",
      "wait",
      "state",
      "capture",
      "kill",
      "list",
      "exists",
    ]) {
      expect(r.stdout).toContain(verb);
    }
  });

  it("--help output for every verb has ZERO references to 'tmux'", async () => {
    const verbs = [
      "spawn",
      "send",
      "interrupt",
      "wait",
      "state",
      "capture",
      "kill",
      "list",
      "exists",
    ];
    const r0 = await runCli(["--help"]);
    expect(r0.stdout.toLowerCase()).not.toContain("tmux");
    for (const v of verbs) {
      const r = await runCli([v, "--help"]);
      expect(r.exit).toBe(0);
      expect(r.stdout.toLowerCase(), `tmux leaked into 'claudemux ${v} --help'`).not.toContain(
        "tmux",
      );
    }
  });
});

describe("CLI — exists / list / kill against empty server", () => {
  it("list with no server running prints nothing and exits 0", async () => {
    const r = await runCli(["list"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exists on a missing session prints 'false' and exits 1", async () => {
    const r = await runCli(["exists", "never-existed"]);
    expect(r.exit).toBe(1);
    expect(r.stdout.trim()).toBe("false");
  });

  it("kill on a missing session is idempotent (exit 0)", async () => {
    const r = await runCli(["kill", "never-existed"]);
    expect(r.exit).toBe(0);
  });
});

describe("CLI — reserved-char names honor each verb's contract (QA P1 7360b35b)", () => {
  // exists/kill are total query/idempotent verbs: a reserved-char name can't
  // name a live session, so they must answer cleanly, NOT throw
  // InvalidSessionName. spawn rejects (mutating entry).
  it("exists '<reserved>' prints 'false' and exits 1 (no InvalidSessionName throw)", async () => {
    const r = await runCli(["exists", "a.b"]);
    expect(r.exit).toBe(1);
    expect(r.stdout.trim()).toBe("false");
    expect(r.stderr).not.toContain("invalid name");
  });

  it("exists '<colon-name>' likewise total", async () => {
    const r = await runCli(["exists", "has:colon"]);
    expect(r.exit).toBe(1);
    expect(r.stdout.trim()).toBe("false");
  });

  it("kill '<reserved>' is idempotent — exit 0, no throw", async () => {
    const r = await runCli(["kill", "gone.session"]);
    expect(r.exit).toBe(0);
    expect(r.stderr).not.toContain("invalid name");
  });

  it("spawn '<reserved>' rejects with InvalidSessionName (mutating entry)", async () => {
    const r = await runCli(["spawn", "a.b", "--cwd", h.sandbox.home, "--boot-timeout-ms", "1000"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("invalid name");
    expect(r.stderr).toContain("a.b");
  });
});

describe("CLI — unknown agent surfaces a typed error", () => {
  it("--agent foo exits non-zero with a clear message", async () => {
    // `state` accepts --agent (kill/list/exists don't classify so they don't).
    const r = await runCli(["state", "anything", "--agent", "foo"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain('unknown agent "foo"');
  });
});

describe("CLI — spawn against real claude in sandbox surfaces LoginRequired cleanly", () => {
  it("spawn <name> --cwd in a fresh sandbox HOME exits non-zero with LoginRequired", async () => {
    const path = `${claudeBinDir()}:${h.env.PATH}`;
    const r = await runCli(
      ["spawn", "preauth", "--cwd", h.sandbox.home, "--boot-timeout-ms", "45000"],
      { PATH: path },
    );
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("not authenticated");
  }, 60_000);
});
