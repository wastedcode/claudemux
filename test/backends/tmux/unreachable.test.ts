import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxExec } from "../../../src/backends/tmux/exec.js";
import { hasSession, killSession, listSessions } from "../../../src/backends/tmux/sessions.js";
import { BackendUnreachable } from "../../../src/errors.js";

/**
 * QA P1 (22f3a2bf) + architect P2 (27bc7b67): the `BackendUnreachable`
 * discriminator. A *missing* backend binary (`spawn-failed`) and a *wedged*
 * backend (`timeout`) must surface loudly — never masquerade as "no sessions
 * exist." Only the `no-server` flavor is swallowed by the query/idempotent
 * verbs.
 */

describe("tmux binary missing (ENOENT) → BackendUnreachable[spawn-failed], NOT silent", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin-dir-claudemux-test";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("exec.run rejects BackendUnreachable[spawn-failed] when tmux is not on PATH", async () => {
    const exec = new TmuxExec("never-used");
    const err = await exec.run(["list-sessions"], { sessionName: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendUnreachable);
    expect((err as BackendUnreachable).kind).toBe("spawn-failed");
  });

  it("hasSession surfaces BackendUnreachable (does NOT silently return false)", async () => {
    const exec = new TmuxExec("never-used");
    await expect(hasSession(exec, "ns--x")).rejects.toBeInstanceOf(BackendUnreachable);
  });

  it("killSession surfaces BackendUnreachable (does NOT silently succeed)", async () => {
    const exec = new TmuxExec("never-used");
    await expect(killSession(exec, "ns--x")).rejects.toBeInstanceOf(BackendUnreachable);
  });

  it("listSessions surfaces BackendUnreachable (does NOT silently return [])", async () => {
    const exec = new TmuxExec("never-used");
    await expect(listSessions(exec, "ns")).rejects.toBeInstanceOf(BackendUnreachable);
  });
});

describe("wedged tmux (process alive, never returns) → BackendUnreachable[timeout]", () => {
  let shimDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // A fake `tmux` shim that sleeps far longer than the per-call timeout.
    shimDir = mkdtempSync(join(tmpdir(), "claudemux-shim-"));
    const shim = join(shimDir, "tmux");
    writeFileSync(shim, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(shim, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (shimDir.startsWith("/tmp/") || shimDir.startsWith("/var/")) {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("exec.run rejects BackendUnreachable[timeout] within the budget (does not hang)", async () => {
    const exec = new TmuxExec("wedged");
    const started = Date.now();
    const err = await exec
      .run(["has-session", "-t", "x"], { sessionName: "x", timeoutMs: 400 })
      .catch((e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(BackendUnreachable);
    expect((err as BackendUnreachable).kind).toBe("timeout");
    // Settled near the timeout, not after the shim's 30s sleep.
    expect(elapsed).toBeLessThan(3_000);
  }, // Test-level guard: if the timeout regresses, this fails loud (not hangs).
  10_000);
});
