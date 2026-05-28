import { describe, expect, it } from "vitest";
import {
  BackendError,
  BackendUnreachable,
  ClaudemuxError,
  DialogStuck,
  LoginRequired,
  PaneDead,
  ReplTimeout,
  SessionExists,
  SessionGone,
} from "./errors.js";

describe("typed errors", () => {
  it("every public error carries the session name in its message", () => {
    const cases: { err: ClaudemuxError; name: string }[] = [
      { err: new SessionExists("x"), name: "x" },
      { err: new DialogStuck("y", "theme-picker"), name: "y" },
      { err: new ReplTimeout("z", 12345), name: "z" },
      { err: new LoginRequired("a"), name: "a" },
      { err: new PaneDead("b", 9), name: "b" },
      { err: new SessionGone("c"), name: "c" },
      { err: new BackendUnreachable("d"), name: "d" },
      {
        err: new BackendError("e", ["tmux", "has-session"], 1, "can't find session: e"),
        name: "e",
      },
    ];
    for (const { err, name } of cases) {
      expect(err.message).toContain(`[claudemux:${name}]`);
      expect(err.sessionName).toBe(name);
      expect(err).toBeInstanceOf(ClaudemuxError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("DialogStuck preserves the dialog id", () => {
    const e = new DialogStuck("s", "workspace-trust");
    expect(e.dialogId).toBe("workspace-trust");
    expect(e.message).toContain("workspace-trust");
  });

  it("ReplTimeout preserves the timeout budget", () => {
    const e = new ReplTimeout("s", 5000);
    expect(e.timeoutMs).toBe(5000);
    expect(e.message).toContain("5000ms");
  });

  it("PaneDead preserves the signal", () => {
    const e = new PaneDead("s", 9);
    expect(e.signal).toBe(9);
    expect(e.message).toContain("signal 9");
  });

  it("BackendUnreachable optionally wraps an underlying cause", () => {
    const cause = new Error("ENOENT");
    const e = new BackendUnreachable("s", cause);
    expect(e.underlying).toBe(cause);
    expect(e.message).toContain("ENOENT");
  });

  it("BackendError preserves argv + exit + stderr on fields", () => {
    const e = new BackendError("s", ["tmux", "has-session", "-t", "s"], 1, "boom");
    expect(e.argv).toEqual(["tmux", "has-session", "-t", "s"]);
    expect(e.exitCode).toBe(1);
    expect(e.stderr).toBe("boom");
    expect(e.message).toContain("exit 1");
    expect(e.message).toContain("boom");
  });

  it("BackendError.message does NOT embed the backend argv (vocabulary guard)", () => {
    // The argv is pure backend vocabulary; leaking it into the message
    // violates the substrate's no-backend-in-errors promise. It lives on
    // .argv for programmatic diagnosis; the message stays clean even when
    // the argv begins with a backend command name.
    const e = new BackendError("s", ["tmux", "capture-pane", "-p", "-t", "s"], 1, "weird failure");
    expect(e.message.toLowerCase()).not.toContain("tmux");
    expect(e.message.toLowerCase()).not.toContain("capture-pane");
    expect(e.argv).toContain("tmux");
  });

  it("error class .name property is the class name (for instanceof-shape logging)", () => {
    expect(new SessionExists("s").name).toBe("SessionExists");
    expect(new LoginRequired("s").name).toBe("LoginRequired");
  });
});
