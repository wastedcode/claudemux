import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/types.js";
import type { Backend, BackendEvent, SessionRef } from "../backends/types.js";
import { SEND_BASELINE_KEY, paneFingerprint } from "./baseline.js";
import { stabilize } from "./stabilize.js";
import { waitForOutcome } from "./wait.js";

/**
 * The send→wait transition race, now expressed as a {@link TurnOutcome}.
 * `wait()` must observe the pane *leave* idle before it accepts a *return* to
 * idle as `completed`; otherwise it reports the previous turn's stale prompt.
 * These cover the **hooks-off / pane** path (no rendezvous) deterministically;
 * the hook-`stop`-edge completion path is covered live by the acceptance suite
 * (real timestamps can't be driven deterministically here).
 *
 * No authenticated claude needed — a scripted backend whose `capture` returns a
 * fixed frame sequence reproduces the race. `paths` is `{}` (no hooks).
 */

const READY = "❯ ";
const WORKING = "✻ Working… (esc to interrupt)";
const DONE = "the answer is 42\n❯ ";
const NO_PATHS = {};

class FrameBackend implements Backend {
  readonly id = "frames";
  #i = 0;
  constructor(
    private frames: string[],
    private baseline?: string,
  ) {}

  capture(_ref: SessionRef): Promise<string> {
    const frame = this.frames[Math.min(this.#i, this.frames.length - 1)] ?? "";
    this.#i++;
    return Promise.resolve(frame);
  }
  getSessionMeta(_ref: SessionRef, key: string): Promise<string | undefined> {
    return Promise.resolve(key === SEND_BASELINE_KEY ? this.baseline : undefined);
  }
  setSessionMeta(): Promise<void> {
    return Promise.resolve();
  }
  spawn(): Promise<void> {
    return Promise.resolve();
  }
  kill(): Promise<void> {
    return Promise.resolve();
  }
  exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  list(): Promise<string[]> {
    return Promise.resolve([]);
  }
  send(): Promise<void> {
    return Promise.resolve();
  }
  onCommand(_h: (e: BackendEvent) => void): () => void {
    return () => undefined;
  }
}

/** Minimal claude-shaped agent: idle = bottom line is the bare ready glyph. */
const agent: AgentDef = {
  name: "fake",
  buildArgv: () => ({ cmd: "fake", argv: [] }),
  boot: { dialogs: [], isReady: (t) => t.trimEnd().endsWith("❯") },
  rules: {
    dialog: () => false,
    permissionPrompt: () => false,
    working: (t) => t.includes("Working"),
    idle: (t) => /❯ ?$/.test(t),
  },
};

const ref: SessionRef = { namespace: "ns", name: "x" };

describe("waitForOutcome — transition-aware completion (the send→wait race)", () => {
  it("completes only on the idle that FOLLOWS a working frame, not the leading stale idles", async () => {
    const backend = new FrameBackend([READY, READY, WORKING, WORKING, DONE]);
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("keeps polling through leading stale idles (a snapshot wait would return on frame[0])", async () => {
    const backend = new FrameBackend([READY, READY, READY, WORKING, DONE]);
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "completed" });
  });

  it("returns budget-exceeded (NOT a throw) if the pane never leaves the stale idle", async () => {
    const backend = new FrameBackend([READY]);
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 400 },
      { stabilize },
    );
    expect(r.kind).toBe("budget-exceeded");
  });

  it("does NOT complete on the post-submit empty prompt that precedes working", async () => {
    const backend = new FrameBackend([READY, WORKING, WORKING, DONE]);
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("returns awaiting{dialog} / awaiting{permission-prompt} immediately (no transition)", async () => {
    const dialogAgent: AgentDef = {
      ...agent,
      rules: { ...agent.rules, dialog: (t) => t.includes("DIALOG") },
    };
    const backend = new FrameBackend(["DIALOG: choose a theme"]);
    const r = await waitForOutcome(
      backend,
      dialogAgent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "awaiting", on: "dialog" });
  });

  it("returns aborted when the pane shows an interrupted turn (restored draft → unknown)", async () => {
    const interruptAgent: AgentDef = {
      ...agent,
      rules: { ...agent.rules, interrupted: (t) => t.includes("Interrupted") },
    };
    // Real post-interrupt pane: claude restores the cut prompt into the composer
    // (a NON-empty box → classifies `unknown`, the only state `aborted` fires on).
    const backend = new FrameBackend(["⎿ Interrupted by user\n❯ Write a long essay"]);
    const r = await waitForOutcome(
      backend,
      interruptAgent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "aborted" });
  });
});

/**
 * The stateless-CLI fast-turn case (bug 8a500a52): `send` and `wait` are
 * separate processes; a fast turn can be back to idle before `wait`'s first
 * poll, so no `working` frame is seen. `send` stashes a post-submit fingerprint;
 * `wait` arms on divergence from it. The baseline is the *post-submit* frame, so
 * the pre-answer window (live == baseline) is not a divergence → no premature
 * completion.
 */
describe("waitForOutcome — cross-process baseline arm (stateless CLI fast turn)", () => {
  const POST_SUBMIT = "you asked: ping\n❯ ";

  it("arms on divergence when the turn completed before the first poll (no working seen)", async () => {
    const backend = new FrameBackend([DONE], paneFingerprint(POST_SUBMIT));
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("does NOT arm while the live pane still equals the post-submit baseline", async () => {
    const backend = new FrameBackend(
      [POST_SUBMIT, POST_SUBMIT, WORKING, DONE],
      paneFingerprint(POST_SUBMIT),
    );
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 5_000 },
      { stabilize },
    );
    expect(r).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("budget-exceeded if the live pane never diverges from the baseline (agent never reacted)", async () => {
    const backend = new FrameBackend([POST_SUBMIT], paneFingerprint(POST_SUBMIT));
    const r = await waitForOutcome(
      backend,
      agent,
      ref,
      NO_PATHS,
      { timeoutMs: 400 },
      { stabilize },
    );
    expect(r.kind).toBe("budget-exceeded");
  });
});
