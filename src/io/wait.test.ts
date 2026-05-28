import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/types.js";
import type { Backend, BackendEvent, SessionRef } from "../backends/types.js";
import { SEND_BASELINE_KEY, paneFingerprint } from "./baseline.js";
import { stabilize } from "./stabilize.js";
import { waitForState } from "./wait.js";

/**
 * Architect P1 (3e24aed1) — the send→wait transition race. `wait()` must
 * observe the pane *leave* idle before it accepts a *return* to idle;
 * otherwise it returns the previous turn's stale prompt as this turn's result.
 * See `engineer/wiki/wait-needs-a-transition-not-a-snapshot`.
 *
 * No authenticated claude needed — a scripted backend whose `capture` returns
 * a fixed frame sequence reproduces the race deterministically.
 */

const READY = "❯ ";
const WORKING = "✻ Working… (esc to interrupt)";
const DONE = "the answer is 42\n❯ ";

/**
 * A backend whose `capture` walks a fixed frame list, repeating the last.
 * `baseline` (optional) is the fingerprint a prior `send` would have stashed —
 * `getSessionMeta(SEND_BASELINE_KEY)` returns it, driving wait's cross-process
 * arm. Omit it to exercise the observed-working (in-process) arm path.
 */
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
  // Unused by waitForState:
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
    // idle = the pane ends on the bare ready glyph (optionally trailing space).
    idle: (t) => /❯ ?$/.test(t),
  },
};

const ref: SessionRef = { namespace: "ns", name: "x" };

describe("waitForState — transition-aware (the send→wait race)", () => {
  it("resolves only on the idle that FOLLOWS a working frame, not the leading stale idles", async () => {
    // The classic race sequence: two stale-idle frames (previous turn's
    // prompt, claude hasn't reacted), then working, then the new idle.
    const backend = new FrameBackend([READY, READY, WORKING, WORKING, DONE]);
    const result = await waitForState(backend, agent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(result).toBe("idle");
    // The final idle is the DONE frame (carries the answer), not the bare READY.
    // Re-capture to confirm the backend has advanced past the leading idles.
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("a snapshot wait would have returned on the FIRST idle — prove we did not", async () => {
    // If wait were snapshot-based it would resolve on frame[0] (READY) almost
    // immediately. Our transition-aware wait must keep polling through the
    // leading idles. We assert the backend was polled past them (i.e. the
    // working frames were consumed) by the time wait resolved.
    const frames = [READY, READY, READY, WORKING, DONE];
    const backend = new FrameBackend(frames);
    const r = await waitForState(backend, agent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(r).toBe("idle");
  });

  it("times out (ReplTimeout) if the pane never leaves the stale idle (agent never reacts)", async () => {
    // Pane sits on the previous prompt forever — no transition. A snapshot
    // wait would falsely return idle; the transition-aware wait correctly
    // refuses and eventually times out.
    const backend = new FrameBackend([READY]);
    await expect(
      waitForState(backend, agent, ref, { timeoutMs: 400 }, { stabilize }),
    ).rejects.toThrow(/did not settle/);
  });

  it("does NOT return on the post-submit empty prompt that precedes working", async () => {
    // The real claude 2.1.153 timeline after Enter: the input box clears to
    // an EMPTY `❯ ` (idle-looking) for ≤200ms BEFORE `esc to interrupt`
    // appears. With no baseline stashed, arm-on-observed-working means this
    // leading empty idle is not a premature return — even though it's the very
    // first frame. (The cross-process baseline arm — exercised below — would
    // also not fire here, because the baseline IS this post-submit frame.)
    const backend = new FrameBackend([READY, WORKING, WORKING, DONE]);
    const r = await waitForState(backend, agent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(r).toBe("idle");
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("returns dialog / permission-prompt immediately (no transition required)", async () => {
    const dialogAgent: AgentDef = {
      ...agent,
      rules: { ...agent.rules, dialog: (t) => t.includes("DIALOG") },
    };
    const backend = new FrameBackend(["DIALOG: choose a theme"]);
    const r = await waitForState(backend, dialogAgent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(r).toBe("dialog");
  });
});

/**
 * P1 (8a500a52) — the stateless-CLI fast-turn hang. `send` and `wait` are
 * separate CLI processes; a fast turn can be back to idle before the `wait`
 * process takes its first capture, so `wait` never observes a `working` frame.
 * Without a cross-process baseline it then waits out the full budget. `send`
 * stashes a post-submit fingerprint; `wait` arms when the live pane diverges
 * from it. The baseline is the *post-submit* frame, so the dangerous pre-answer
 * window (live pane == baseline) is NOT a divergence → no premature return.
 */
describe("waitForState — cross-process baseline arm (stateless CLI fast turn)", () => {
  const POST_SUBMIT = "you asked: ping\n❯ ";

  it("arms on divergence when the turn already completed before the first poll (no working seen)", async () => {
    // The bug: only DONE frames are ever observed (the turn finished in the
    // send→wait process gap). With the post-submit baseline, DONE diverges from
    // it → wait arms and returns idle instead of hanging to ReplTimeout.
    const backend = new FrameBackend([DONE], paneFingerprint(POST_SUBMIT));
    const r = await waitForState(backend, agent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(r).toBe("idle");
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("does NOT arm while the live pane still equals the post-submit baseline", async () => {
    // wait starts inside the post-submit window (live pane == baseline): it must
    // NOT arm on those leading idle frames (that would return the previous
    // turn's answer). It arms only once the pane diverges — here when `working`
    // appears — and returns the DONE idle.
    const backend = new FrameBackend(
      [POST_SUBMIT, POST_SUBMIT, WORKING, DONE],
      paneFingerprint(POST_SUBMIT),
    );
    const r = await waitForState(backend, agent, ref, { timeoutMs: 5_000 }, { stabilize });
    expect(r).toBe("idle");
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("times out if the live pane never diverges from the baseline (agent never reacted)", async () => {
    // A baseline that matches the live idle forever must NOT falsely arm — the
    // turn genuinely never ran, so wait correctly times out rather than
    // returning a stale idle.
    const backend = new FrameBackend([POST_SUBMIT], paneFingerprint(POST_SUBMIT));
    await expect(
      waitForState(backend, agent, ref, { timeoutMs: 400 }, { stabilize }),
    ).rejects.toThrow(/did not settle/);
  });
});
