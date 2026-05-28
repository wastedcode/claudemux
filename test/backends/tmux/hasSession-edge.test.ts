import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxExec } from "../../../src/backends/tmux/exec.js";
import { tmuxBackend } from "../../../src/backends/tmux/index.js";
import { hasSession, newSession, targetOf } from "../../../src/backends/tmux/sessions.js";
import { InvalidSessionName } from "../../../src/errors.js";
import { Harness } from "../../harness/index.js";

/**
 * QA P1-1 — `hasSession` must return `false` (never throw) for every name
 * tmux can't find, including names that trip tmux's target grammar
 * (`<session>:<window>.<pane>`). Previously, `hasSession` only treated
 * `can't find session:` as "false" and let `can't find pane:` / `can't
 * find window:` through to `SessionGone`.
 *
 * Pairs with the substrate-boundary validation that rejects such names at
 * `create()` / `spawn()` — but the boolean contract on `hasSession`
 * (and so the `exists()` CLI verb) must still hold for any string a
 * caller passes via the Backend interface directly.
 */

let h: Harness;
let exec: TmuxExec;

beforeEach(() => {
  h = Harness.create();
  exec = new TmuxExec(h.socket);
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

describe("hasSession — returns false (never throws) for tmux-grammar-tripping names", () => {
  it("returns false for a name with `.` against a running server", async () => {
    // Bring a server up first — without one, hasSession returns false for
    // ANY name (no-server short-circuit). We need a server up so the actual
    // `can't find pane:`/`can't find window:` paths fire.
    await newSession(exec, {
      namespace: "ns",
      name: "alive",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    // Note: we deliberately bypass create()'s validation here by calling
    // sessions.hasSession directly with a target string that includes `.`.
    expect(await hasSession(exec, "ns--has.dot")).toBe(false);
  });

  it("returns false for a name with `:`", async () => {
    await newSession(exec, {
      namespace: "ns",
      name: "alive2",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    expect(await hasSession(exec, "ns--has:colon")).toBe(false);
  });

  it("returns false for a name with `*` (tmux glob metachar)", async () => {
    await newSession(exec, {
      namespace: "ns",
      name: "alive3",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    expect(await hasSession(exec, "ns--has*star")).toBe(false);
  });

  it("returns true for the corresponding well-formed name (sanity check)", async () => {
    await newSession(exec, {
      namespace: "ns",
      name: "alive4",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    expect(await hasSession(exec, targetOf("ns", "alive4"))).toBe(true);
  });
});

describe("tmuxBackend wrapper — exists/kill total for reserved-char names (QA P1 7360b35b)", () => {
  it("exists() returns false (does NOT throw InvalidSessionName) for a reserved-char name", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await expect(backend.exists({ namespace: "ns", name: "has.dot" })).resolves.toBe(false);
    await expect(backend.exists({ namespace: "ns", name: "has:colon" })).resolves.toBe(false);
  });

  it("kill() is a no-op (resolves, does NOT throw) for a reserved-char name", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await expect(backend.kill({ namespace: "ns", name: "has.dot" })).resolves.toBeUndefined();
  });

  it("spawn() still rejects a reserved-char name with InvalidSessionName", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await expect(
      backend.spawn({
        namespace: "ns",
        name: "has.dot",
        cwd: h.sandbox.home,
        cmd: "sleep",
        argv: ["60"],
      }),
    ).rejects.toBeInstanceOf(InvalidSessionName);
  });
});
