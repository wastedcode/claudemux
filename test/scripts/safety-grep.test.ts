import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Meta-tests for the four CI safety/layering scripts. Each script must:
 *   (a) exit 0 on the actual repo (covered by CI),
 *   (b) exit non-zero against a contrived fixture that violates the rule
 *       (proved here so the script can't silently become a no-op).
 */

const repoRoot = process.cwd();

function runScript(script: string, cwd: string): { exit: number; stderr: string } {
  try {
    // execFile (argv array), not a shell string: `bash <path> .` runs with no
    // shell, so the repo path (process.cwd()) can't be interpreted as shell
    // syntax even if it contains metacharacters (CodeQL: shell-command-from-env).
    execFileSync("bash", [join(repoRoot, "scripts", script), "."], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exit: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    return { exit: e.status ?? -1, stderr: e.stderr?.toString() ?? "" };
  }
}

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "claudemux-safety-fixture-"));
});

afterEach(() => {
  if (fixtureRoot.startsWith("/tmp/") || fixtureRoot.startsWith("/var/")) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("safety-grep.sh — must catch peer-process name matchers", () => {
  it("flags `pkill claude` in a test fixture", () => {
    mkdirSync(join(fixtureRoot, "test"));
    writeFileSync(join(fixtureRoot, "test", "bad.sh"), 'echo "cleaning up"\npkill claude\n');
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("pkill");
  });

  it("flags `killall claude` likewise", () => {
    mkdirSync(join(fixtureRoot, "scripts"));
    writeFileSync(join(fixtureRoot, "scripts", "clean.sh"), "killall claude\n");
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("killall");
  });

  it("flags `pgrep -f claude` likewise", () => {
    mkdirSync(join(fixtureRoot, "test"));
    writeFileSync(join(fixtureRoot, "test", "x.sh"), "pgrep -f claude\n");
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
  });

  it("flags a tmux invocation missing -f /dev/null", () => {
    mkdirSync(join(fixtureRoot, "scripts"));
    writeFileSync(
      join(fixtureRoot, "scripts", "broken.sh"),
      "tmux -L mysock new-session -d -s test sleep 60\n",
    );
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("-f /dev/null");
  });

  it("ALLOWS a tmux invocation that has -f /dev/null", () => {
    mkdirSync(join(fixtureRoot, "scripts"));
    writeFileSync(
      join(fixtureRoot, "scripts", "good.sh"),
      "tmux -L mysock -f /dev/null new-session -d -s t sleep 60\n",
    );
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).toBe(0);
  });

  it("ALLOWS comment-only references (rule documentation)", () => {
    mkdirSync(join(fixtureRoot, "src"));
    writeFileSync(
      join(fixtureRoot, "src", "docs.ts"),
      "// Banned: pkill claude — never use this peer-kill\n",
    );
    const r = runScript("safety-grep.sh", fixtureRoot);
    expect(r.exit).toBe(0);
  });
});

describe("layering-grep.sh — must catch cross-layer breaches", () => {
  it("flags src/backends importing from src/agents", () => {
    mkdirSync(join(fixtureRoot, "src", "backends"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src", "agents"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "src", "backends", "bad.ts"),
      'import { claude } from "../agents/claude.js";\n',
    );
    const r = runScript("layering-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("backends");
  });

  it("flags src/agents importing from src/backends", () => {
    mkdirSync(join(fixtureRoot, "src", "backends"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src", "agents"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "src", "agents", "bad.ts"),
      'import { tmuxBackend } from "../backends/tmux/index.js";\n',
    );
    const r = runScript("layering-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("agents");
  });

  it("flags a claude string literal in src/backends/", () => {
    mkdirSync(join(fixtureRoot, "src", "backends", "tmux"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "src", "backends", "tmux", "leaky.ts"),
      'const match = "Choose the text style";\n',
    );
    const r = runScript("layering-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("Choose the text style");
  });

  it("flags a tmux command name as a string in src/agents/", () => {
    mkdirSync(join(fixtureRoot, "src", "agents"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "src", "agents", "bad.ts"),
      'const args = ["capture-pane", "-p"];\n',
    );
    const r = runScript("layering-grep.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("capture-pane");
  });
});

describe("no-tmux-in-public.sh — must catch tmux leaks into the public surface", () => {
  it("flags 'tmux' in src/index.ts", () => {
    mkdirSync(join(fixtureRoot, "src"));
    writeFileSync(
      join(fixtureRoot, "src", "index.ts"),
      'export { tmuxBackend } from "./backends/tmux/index.js";\n',
    );
    // Don't create src/types.ts or src/errors.ts — the script skips missing files.
    const r = runScript("no-tmux-in-public.sh", fixtureRoot);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("tmux");
  });
});
