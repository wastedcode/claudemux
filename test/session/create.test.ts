import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmuxBackend } from "../../src/backends/tmux/index.js";
import { LoginRequired, SessionExists } from "../../src/errors.js";
import { create } from "../../src/session/create.js";
import { Harness } from "../harness/index.js";

let h: Harness;

beforeEach(() => {
  h = Harness.create();
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

describe("create() — SessionExists collision", () => {
  it("throws SessionExists if a session with the same name already exists", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await backend.spawn({
      namespace: "claudemux",
      name: "collide",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });

    await expect(
      create({
        name: "collide",
        cwd: h.sandbox.home,
        backend,
        bootTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(SessionExists);

    await backend.kill("claudemux--collide");
  });
});

describe("create() — pre-auth boot path against real claude (LoginRequired clean throw)", () => {
  it("dismisses theme picker, then surfaces LoginRequired from login-method dialog", async () => {
    // The sandbox HOME has no ~/.claude/credentials.* — claude shows theme
    // picker first, then login method. The substrate boots the theme picker
    // automatically (Enter) and then must throw LoginRequired.
    const backend = tmuxBackend({ socket: h.socket });
    const env = {
      ...h.env,
      PATH: `/home/claude/.local/bin:${h.env.PATH}`,
    };

    await expect(
      create({
        name: "preauth",
        cwd: h.sandbox.home,
        backend,
        env,
        bootTimeoutMs: 45_000,
      }),
    ).rejects.toThrow(LoginRequired);

    // create() best-effort kills the session on boot failure — verify gone.
    const exists = await backend.exists("claudemux--preauth");
    expect(exists).toBe(false);
  }, 60_000);
});
