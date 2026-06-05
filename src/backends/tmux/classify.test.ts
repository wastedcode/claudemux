import { describe, expect, it } from "vitest";
import { BackendError, BackendUnreachable, SessionExists, SessionGone } from "../../errors.js";
import {
  type TmuxExec,
  type TmuxResult,
  classifyTmuxFailure,
  isDuplicateSessionStderr,
  isNoServerStderr,
  isSessionGoneStderr,
  runForSession,
} from "./exec.js";

/**
 * Structural meta-test for the stderr classifiers. The substrate's
 * no-backend-vocabulary promise is whack-a-mole if each new tmux stderr
 * shape leaks until we notice it. Two structural guarantees here:
 *
 *   1. Each known routine shape maps to the right typed error (so the
 *      catch-all BackendError is reserved for genuinely-unexpected cases).
 *   2. classifyTmuxFailure NEVER produces an error whose `.message`
 *      contains "tmux" — for ANY stderr input, classified or not — because
 *      BackendError.message excludes the argv (the only guaranteed-tmux part).
 */

const mk = (stderr: string, exit = 1): TmuxResult => ({ exit, stdout: "", stderr, durationMs: 1 });
const ARGV = ["tmux", "new-session", "-d", "-s", "ns--x"];

describe("stderr classifier predicates — single-source, exhaustive", () => {
  it("isNoServerStderr matches both tmux shapes", () => {
    expect(isNoServerStderr("no server running on /tmp/tmux-1001/sock")).toBe(true);
    expect(
      isNoServerStderr("error connecting to /tmp/tmux-1001/sock (No such file or directory)"),
    ).toBe(true);
    expect(isNoServerStderr("duplicate session: x")).toBe(false);
  });

  it("isSessionGoneStderr matches all three target levels", () => {
    expect(isSessionGoneStderr("can't find session: x")).toBe(true);
    expect(isSessionGoneStderr("can't find window: x")).toBe(true);
    expect(isSessionGoneStderr("can't find pane: x")).toBe(true);
    expect(isSessionGoneStderr("duplicate session: x")).toBe(false);
  });

  it("isDuplicateSessionStderr matches the race shape", () => {
    expect(isDuplicateSessionStderr("duplicate session: ns--race")).toBe(true);
    expect(isDuplicateSessionStderr("can't find session: x")).toBe(false);
  });
});

describe("classifyTmuxFailure — routine shapes → typed errors", () => {
  it("exit 0 → null", () => {
    expect(classifyTmuxFailure("ns/x", ARGV, mk("", 0))).toBeNull();
  });
  it("no server → BackendUnreachable", () => {
    expect(
      classifyTmuxFailure("ns/x", ARGV, mk("error connecting to /tmp/tmux-1/s")),
    ).toBeInstanceOf(BackendUnreachable);
  });
  it("duplicate session → SessionExists", () => {
    expect(classifyTmuxFailure("ns/x", ARGV, mk("duplicate session: ns--x"))).toBeInstanceOf(
      SessionExists,
    );
  });
  it("can't find * → SessionGone", () => {
    expect(classifyTmuxFailure("ns/x", ARGV, mk("can't find window: ns--x"))).toBeInstanceOf(
      SessionGone,
    );
  });
});

describe("runForSession — canonical per-session failure mapping (the read/write anti-drift)", () => {
  // runForSession only calls `.run`; cast the minimal fake to the full type.
  const exec = (run: TmuxExec["run"]): TmuxExec => ({ run }) as unknown as TmuxExec;
  const noServer = () =>
    new BackendUnreachable("ns/x", "no-server", new Error("no server running"));

  it("no-server REJECTION → SessionGone (a per-session op on a dead server = this session is gone)", async () => {
    const e = exec(() => Promise.reject(noServer()));
    await expect(runForSession(e, ["capture-pane", "-p"], "ns/x")).rejects.toBeInstanceOf(
      SessionGone,
    );
  });

  it("no-server RETURNED result → SessionGone too (belt-and-braces)", async () => {
    const e = exec(() =>
      Promise.resolve({
        exit: 1,
        stdout: "",
        stderr: "no server running on /tmp/s",
        durationMs: 1,
      }),
    );
    await expect(runForSession(e, ["capture-pane", "-p"], "ns/x")).rejects.toBeInstanceOf(
      SessionGone,
    );
  });

  it("a REAL backend fault (spawn-failed) is NOT remapped — it stays BackendUnreachable", async () => {
    const e = exec(() => Promise.reject(new BackendUnreachable("ns/x", "spawn-failed")));
    await expect(runForSession(e, ["send-keys", "-t", "x", "1"], "ns/x")).rejects.toBeInstanceOf(
      BackendUnreachable,
    );
  });

  it("session-gone stderr → SessionGone; an unclassified failure → BackendError; success → the result", async () => {
    const gone = exec(() =>
      Promise.resolve({ exit: 1, stdout: "", stderr: "can't find session: ns--x", durationMs: 1 }),
    );
    await expect(runForSession(gone, ["capture-pane"], "ns/x")).rejects.toBeInstanceOf(SessionGone);
    const weird = exec(() =>
      Promise.resolve({ exit: 1, stdout: "", stderr: "no space left on device", durationMs: 1 }),
    );
    await expect(runForSession(weird, ["capture-pane"], "ns/x")).rejects.toBeInstanceOf(
      BackendError,
    );
    const ok = exec(() => Promise.resolve({ exit: 0, stdout: "PANE", stderr: "", durationMs: 1 }));
    expect((await runForSession(ok, ["capture-pane"], "ns/x")).stdout).toBe("PANE");
  });
});

describe("classifyTmuxFailure — vocabulary guard (the structural backstop)", () => {
  // Whatever stderr tmux emits — classified or unclassified — the resulting
  // error's .message must never contain the backend's command vocabulary.
  const stderrs = [
    "duplicate session: ns--x",
    "can't find session: ns--x",
    "no server running on /tmp/sock",
    "error connecting to /tmp/sock",
    "some entirely unexpected failure we have never classified",
    "lost server",
    "no space left on device",
  ];
  for (const stderr of stderrs) {
    it(`message clean for: ${JSON.stringify(stderr)}`, () => {
      const err = classifyTmuxFailure("ns/x", ARGV, mk(stderr));
      // exit 0 returns null; all our fixtures are exit 1 so err is non-null.
      expect(err).not.toBeNull();
      if (!err) return;
      expect(err.message.toLowerCase()).not.toContain("tmux");
      // It also must not echo the raw backend argv tokens.
      expect(err.message).not.toContain("new-session");
    });
  }
});
