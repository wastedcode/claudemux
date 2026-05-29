import { describe, expect, it } from "vitest";
import {
  AgentExitedDuringBoot,
  AgentSessionIdConflict,
  BackendError,
  BackendUnreachable,
  ClaudemuxError,
  DialogStuck,
  InvalidAgentSessionId,
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
      { err: new BackendUnreachable("d", "no-server"), name: "d" },
      {
        err: new BackendError("e", ["tmux", "has-session"], 1, "can't find session: e"),
        name: "e",
      },
      { err: new AgentSessionIdConflict("f"), name: "f" },
      { err: new AgentExitedDuringBoot("g"), name: "g" },
      { err: new AgentExitedDuringBoot("h", "abcdef01-2345-4678-9abc-def012345678"), name: "h" },
      // InvalidAgentSessionId has no real session (thrown before spawn) — it
      // uses a placeholder name, mirroring InvalidSessionName.
      { err: new InvalidAgentSessionId("nope"), name: "<invalid-agentSessionId>" },
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

  it("BackendUnreachable carries kind + optionally wraps an underlying cause", () => {
    const cause = new Error("ENOENT");
    const e = new BackendUnreachable("s", "spawn-failed", cause);
    expect(e.kind).toBe("spawn-failed");
    expect(e.underlying).toBe(cause);
    expect(e.message).toContain("ENOENT");
    expect(e.message).toContain("spawn-failed");
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

  it("InvalidAgentSessionId carries the offending value and names the UUID requirement", () => {
    const e = new InvalidAgentSessionId("not-a-uuid");
    expect(e.value).toBe("not-a-uuid");
    expect(e.message).toContain("v4 UUID");
    // The offending value is JSON-encoded (so control chars can't break the line).
    expect(e.message).toContain(JSON.stringify("not-a-uuid"));
  });

  it("AgentExitedDuringBoot is optional-id and carries the chosen id when present", () => {
    const without = new AgentExitedDuringBoot("s");
    expect(without.agentSessionId).toBeUndefined();
    expect(without.message).toContain("exited before the session became ready");

    const id = "abcdef01-2345-4678-9abc-def012345678";
    const withId = new AgentExitedDuringBoot("s", id);
    expect(withId.agentSessionId).toBe(id);
    expect(withId.message).toContain(id);
    // Classify-don't-echo: the message is bounded prose — no raw pane / stderr /
    // ANSI is ever blasted through (there is nothing raw to echo by design).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control chars leak
    expect(withId.message).not.toMatch(/[\x00-\x08\x1b]/);
  });

  it("error class .name property is the class name (for instanceof-shape logging)", () => {
    expect(new SessionExists("s").name).toBe("SessionExists");
    expect(new LoginRequired("s").name).toBe("LoginRequired");
    expect(new AgentExitedDuringBoot("s").name).toBe("AgentExitedDuringBoot");
    expect(new AgentSessionIdConflict("s").name).toBe("AgentSessionIdConflict");
    expect(new InvalidAgentSessionId("x").name).toBe("InvalidAgentSessionId");
  });
});
