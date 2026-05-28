import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/types.js";
import type { Backend, BackendEvent, SessionRef } from "../backends/types.js";
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

/** A backend whose `capture` walks a fixed frame list, repeating the last. */
class FrameBackend implements Backend {
  readonly id = "frames";
  #i = 0;
  constructor(private frames: string[]) {}

  capture(_ref: SessionRef): Promise<string> {
    const frame = this.frames[Math.min(this.#i, this.frames.length - 1)] ?? "";
    this.#i++;
    return Promise.resolve(frame);
  }
  // Unused by waitForState:
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
    // appears. arm-on-observed-working means this leading empty idle is not a
    // premature return — even though it's the very first frame. (A
    // baseline-differs arm would have fired here and returned early; we
    // dropped it for exactly this reason.)
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
