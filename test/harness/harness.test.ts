import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness } from "./index.js";

let h: Harness;

beforeEach(() => {
  h = Harness.create();
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

describe("Harness — five guards smoke test", () => {
  it("guard 1: tmux invocations carry -L <socket> -f /dev/null", () => {
    const argv = h.tmux("new-session", "-d", "-s", "x");
    expect(argv.slice(0, 4)).toEqual(["-L", h.socket, "-f", "/dev/null"]);
  });

  it("guard 2: sandbox HOME has all four XDG dirs and lives under the system temp", () => {
    expect(h.sandbox.home).toMatch(/^\/(tmp|var)\//);
    expect(existsSync(h.sandbox.xdgConfig)).toBe(true);
    expect(existsSync(h.sandbox.xdgCache)).toBe(true);
    expect(existsSync(h.sandbox.xdgData)).toBe(true);
    expect(existsSync(h.sandbox.xdgState)).toBe(true);
  });

  it("guard 3: spawned children see only the curated env (no parent leakage)", async () => {
    const sentinelVar = "CLAUDEMUX_HARNESS_PROBE";
    process.env[sentinelVar] = "would-leak-if-inherited";
    try {
      const r = await h.run("/bin/sh", [
        "-c",
        `printf 'HOME=%s\\nXDG_CONFIG_HOME=%s\\n${sentinelVar}=%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$${sentinelVar}"`,
      ]);
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain(`HOME=${h.sandbox.home}`);
      expect(r.stdout).toContain(`XDG_CONFIG_HOME=${h.sandbox.xdgConfig}`);
      expect(r.stdout).toContain(`${sentinelVar}=\n`);
    } finally {
      delete process.env[sentinelVar];
    }
  });

  it("guard 4: child writes land in sandbox HOME, never the real ~/.claude/", async () => {
    const probeFile = ".claude/test-write-from-harness.txt";
    const r = await h.run("/bin/sh", [
      "-c",
      `mkdir -p "$HOME/.claude" && echo from-harness > "$HOME/${probeFile}"`,
    ]);
    expect(r.exit).toBe(0);
    const expected = join(h.sandbox.home, probeFile);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf8").trim()).toBe("from-harness");

    const real = join(homedir(), probeFile);
    expect(existsSync(real)).toBe(false);
  });

  it("guard 5: the harness can actually drive tmux on its private socket", async () => {
    const name = "harness-smoke";
    const r1 = await h.runTmux("new-session", "-d", "-s", name, "sleep", "30");
    expect(r1.exit).toBe(0);
    const r2 = await h.runTmux("has-session", "-t", name);
    expect(r2.exit).toBe(0);
    const r3 = await h.runTmux("kill-session", "-t", name);
    expect(r3.exit).toBe(0);
    const r4 = await h.runTmux("has-session", "-t", name);
    expect(r4.exit).not.toBe(0);
  });
});

describe("Harness — sentinel guard catches the leak it exists for", () => {
  it("a contrived sandbox-bypass that mutates the real sentinel is detected", async () => {
    const sentinelPath = join(homedir(), ".claude", ".do-not-touch-sentinel");
    const original = statSync(sentinelPath);
    const offending = Harness.create();
    try {
      // Bypass the sandbox on purpose: touch the real sentinel.
      const futureSec = Math.floor(original.mtimeMs / 1000) + 5;
      utimesSync(sentinelPath, futureSec, futureSec);
      const leak = await offending.teardown();
      expect(leak).toMatch(/sentinel mtime moved/);
    } finally {
      // Restore the EXACT original times so the file-scope afterEach sees an
      // unchanged sentinel. Pass seconds-as-float (mtimeMs / 1000) — NOT
      // Math.floor — so sub-second precision survives. Flooring discarded up
      // to ~1s, which read as a leak on filesystems that record sub-second
      // mtimes (CI) though not on whole-second ones (some dev boxes).
      utimesSync(sentinelPath, original.atimeMs / 1000, original.mtimeMs / 1000);
    }
  });
});
