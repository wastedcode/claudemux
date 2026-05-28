import { describe, expect, it } from "vitest";
import { BackendUnreachable, SessionExists, SessionGone } from "../../errors.js";
import {
  type TmuxResult,
  classifyTmuxFailure,
  isDuplicateSessionStderr,
  isNoServerStderr,
  isSessionGoneStderr,
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
