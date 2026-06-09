import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxExec, classifyTmuxFailure } from "../../../src/backends/tmux/exec.js";
import {
  hasSession,
  killSession,
  listSessions,
  newSession,
  targetOf,
} from "../../../src/backends/tmux/sessions.js";
import { BackendUnreachable, SessionGone } from "../../../src/errors.js";
import { Harness } from "../../harness/index.js";

let h: Harness;
let exec: TmuxExec;
const NS = "test";

beforeEach(() => {
  h = Harness.create();
  exec = new TmuxExec(h.socket);
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

describe("TmuxExec — discipline + spawn-time errors", () => {
  it("every invocation carries -L <socket> -f /dev/null", async () => {
    const observed: string[][] = [];
    exec.onCommand((e) => observed.push(e.argv));
    // list-sessions against an empty server now (correctly) promotes to
    // BackendUnreachable — we only care about the observed argv here, so
    // swallow the rejection.
    await exec.run(["list-sessions", "-F", "#{session_name}"]).catch(() => undefined);
    expect(observed).toHaveLength(1);
    const argv = observed[0];
    expect(argv).toBeDefined();
    if (!argv) return;
    expect(argv.slice(0, 5)).toEqual(["tmux", "-L", h.socket, "-f", "/dev/null"]);
  });

  it("a non-existent tmux binary surfaces BackendUnreachable", async () => {
    // Override PATH so `tmux` resolves to nothing.
    const originalPath = process.env.PATH;
    process.env.PATH = "/nowhere";
    const isolatedExec = new TmuxExec("never-used");
    try {
      await expect(isolatedExec.run(["list-sessions"], { sessionName: "x" })).rejects.toThrow(
        BackendUnreachable,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reads BOTH stdout and stderr (the pane-death and session-gone halves)", async () => {
    // Bring a server up first so the stderr is "can't find session" not "no server."
    await newSession(exec, {
      namespace: NS,
      name: "running",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const r = await exec.run(["has-session", "-t", "test--never-existed"], {
      sessionName: "test--never-existed",
    });
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("can't find session");
  });
});

describe("classifyTmuxFailure", () => {
  it("returns null for exit 0", () => {
    expect(
      classifyTmuxFailure("x", ["tmux"], { exit: 0, stdout: "", stderr: "", durationMs: 1 }),
    ).toBeNull();
  });

  it("maps 'can't find session:' stderr → SessionGone (Case B)", () => {
    const err = classifyTmuxFailure("x", ["tmux", "has-session"], {
      exit: 1,
      stdout: "",
      stderr: "can't find session: x",
      durationMs: 1,
    });
    expect(err).toBeInstanceOf(SessionGone);
  });

  it("maps 'can't find pane:' stderr → SessionGone", () => {
    const err = classifyTmuxFailure("x", ["tmux"], {
      exit: 1,
      stdout: "",
      stderr: "can't find pane: x",
      durationMs: 1,
    });
    expect(err).toBeInstanceOf(SessionGone);
  });

  it("maps 'can't find window:' stderr → SessionGone", () => {
    const err = classifyTmuxFailure("x", ["tmux"], {
      exit: 1,
      stdout: "",
      stderr: "can't find window: x",
      durationMs: 1,
    });
    expect(err).toBeInstanceOf(SessionGone);
  });

  it("unknown stderr → BackendError", () => {
    const err = classifyTmuxFailure("x", ["tmux"], {
      exit: 2,
      stdout: "",
      stderr: "something else went wrong",
      durationMs: 1,
    });
    expect(err?.constructor.name).toBe("BackendError");
  });
});

describe("sessions module — namespace-isolated CRUD", () => {
  it("newSession + hasSession + killSession round-trip", async () => {
    const NAME = "alpha";
    const target = targetOf(NS, NAME);
    await newSession(exec, {
      namespace: NS,
      name: NAME,
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    expect(await hasSession(exec, target)).toBe(true);
    await killSession(exec, target);
    expect(await hasSession(exec, target)).toBe(false);
  });

  it("killSession is idempotent — repeat kills are success, never throw", async () => {
    const target = targetOf(NS, "never-existed");
    await killSession(exec, target);
    await killSession(exec, target);
    expect(await hasSession(exec, target)).toBe(false);
  });

  it("listSessions returns short names filtered to the namespace", async () => {
    await newSession(exec, {
      namespace: NS,
      name: "one",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    await newSession(exec, {
      namespace: NS,
      name: "two",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    await newSession(exec, {
      namespace: "other",
      name: "skip",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const names = (await listSessions(exec, NS)).sort();
    expect(names).toEqual(["one", "two"]);
    const others = await listSessions(exec, "other");
    expect(others).toEqual(["skip"]);
  });

  it("listSessions with no server running returns []", async () => {
    // Don't spawn any session — the server is not running.
    expect(await listSessions(exec, NS)).toEqual([]);
  });

  it("Case B (pane reaped, remain-on-exit off): has-session=false after process death", async () => {
    const NAME = "case-b";
    const target = targetOf(NS, NAME);
    // Use a short-lived command; the substrate's default remain-on-exit off
    // means the session is reaped when the process exits.
    await newSession(exec, {
      namespace: NS,
      name: NAME,
      cwd: h.sandbox.home,
      cmd: "/bin/sh",
      argv: ["-c", "echo hi"],
    });
    // Wait briefly for the process to exit and the session to be reaped.
    await new Promise((res) => setTimeout(res, 400));
    expect(await hasSession(exec, target)).toBe(false);
  });

  // ── unsetEnv → `env -u` launch prefix (ADR 0008) ─────────────────────────
  // Assert the EMITTED new-session argv via onCommand (no dependence on the
  // wrapped command's runtime behavior): the scrub is a command-assembly
  // concern, so inspecting the issued argv is the right unit.
  describe("unsetEnv emits an `env -u … --` launch prefix", () => {
    /** Capture the new-session argv issued for one spawn. */
    async function spawnAndCapture(o: {
      name: string;
      cmd: string;
      argv: string[];
      env?: Record<string, string>;
      unsetEnv?: string[];
    }): Promise<string[]> {
      let issued: string[] | undefined;
      const off = exec.onCommand((e) => {
        if (e.argv.includes("new-session")) issued = e.argv;
      });
      await newSession(exec, {
        namespace: NS,
        name: o.name,
        cwd: h.sandbox.home,
        cmd: o.cmd,
        argv: o.argv,
        ...(o.env ? { env: o.env } : {}),
        ...(o.unsetEnv ? { unsetEnv: o.unsetEnv } : {}),
      });
      off();
      expect(issued).toBeDefined();
      return issued ?? [];
    }

    it("wraps the launch in `env -u NAME … -- <cmd> <argv>` for each unset name", async () => {
      const argv = await spawnAndCapture({
        name: "scrub",
        cmd: "sleep",
        argv: ["60"],
        unsetEnv: ["CLAUDECODE", "AI_AGENT"],
      });
      // The pane command must read: env -u CLAUDECODE -u AI_AGENT -- sleep 60
      const launch = argv.slice(argv.indexOf("env"));
      expect(launch).toEqual([
        "env",
        "-u",
        "CLAUDECODE",
        "-u",
        "AI_AGENT",
        "--",
        "sleep",
        "60",
      ]);
    });

    it("drops `-u NAME` for a name also in the set env — explicit set wins, emits `-e`", async () => {
      const argv = await spawnAndCapture({
        name: "overlap",
        cmd: "sleep",
        argv: ["60"],
        env: { CLAUDECODE: "1" },
        unsetEnv: ["CLAUDECODE"],
      });
      // The set value rides as `-e CLAUDECODE=1` …
      expect(argv).toContain("-e");
      expect(argv).toContain("CLAUDECODE=1");
      // … and the `-u CLAUDECODE` is dropped, so no `env` wrapper at all
      // (it was the only unset name).
      expect(argv).not.toContain("-u");
      expect(argv).not.toContain("env");
    });

    it("empty/absent unsetEnv → exactly `<cmd> <argv>` with no `env` wrapper", async () => {
      const argv = await spawnAndCapture({
        name: "noscrub",
        cmd: "sleep",
        argv: ["60"],
      });
      expect(argv).not.toContain("env");
      expect(argv).not.toContain("-u");
      // The command tail is the bare cmd + argv, byte-identical to before.
      expect(argv.slice(argv.length - 2)).toEqual(["sleep", "60"]);
    });
  });

  it("applies the five per-session options (verifies escape-time + history-limit at minimum)", async () => {
    const NAME = "opts";
    const target = targetOf(NS, NAME);
    await newSession(exec, {
      namespace: NS,
      name: NAME,
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const escR = await exec.run(["display-message", "-p", "-t", target, "#{escape-time}"], {
      sessionName: target,
    });
    expect(escR.stdout.trim()).toBe("0");
    const histR = await exec.run(["display-message", "-p", "-t", target, "#{history_limit}"], {
      sessionName: target,
    });
    expect(histR.stdout.trim()).toBe("50000");
  });
});
