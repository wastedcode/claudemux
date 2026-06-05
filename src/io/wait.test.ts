import { describe, expect, it } from "vitest";
import type { AgentDef } from "../agents/types.js";
import type { Backend, BackendEvent, SessionRef } from "../backends/types.js";
import type { Belief } from "../observe/observer.js";
import { believe } from "../observe/observer.js";
import { CLASSIFIER_CAPTURE } from "../session/constants.js";
import { classify } from "../state/classifier.js";
import { SEND_BASELINE_KEY, paneFingerprint } from "./baseline.js";
import { stabilize } from "./stabilize.js";
import { type BeliefReader, waitForOutcome } from "./wait.js";

/**
 * The send→wait transition race, as a {@link TurnOutcome}. `wait()` must observe
 * the pane *leave* idle before it accepts a *return* to idle as `completed`. These
 * cover the **hooks-off / pane** path deterministically (the reader is fed no
 * edges); the hook-`stop`-edge completion path is covered live by the acceptance
 * suite (real timestamps can't be driven here). A scripted backend whose `capture`
 * walks a fixed frame list reproduces the race.
 */

const READY = "❯ ";
const WORKING = "✻ Working… (esc to interrupt)";
const DONE = "the answer is 42\n❯ ";

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

/** The handle's job, in miniature: capture+classify the pane, fuse (no hooks here). */
const reader =
  (backend: Backend, ag: AgentDef): BeliefReader =>
  async () => {
    const paneText = await backend.capture(ref, CLASSIFIER_CAPTURE);
    const pane = {
      state: classify(paneText, ag.rules),
      interrupted: ag.rules.interrupted?.(paneText) ?? false,
    };
    return { belief: believe({ edges: [], transcriptCount: 0, pane }), paneText };
  };

const run = (backend: Backend, ag: AgentDef, timeoutMs: number) =>
  waitForOutcome(backend, ref, { timeoutMs }, { stabilize }, reader(backend, ag));

describe("waitForOutcome — transition-aware completion (the send→wait race)", () => {
  it("completes only on the idle that FOLLOWS a working frame, not the leading stale idles", async () => {
    const backend = new FrameBackend([READY, READY, WORKING, WORKING, DONE]);
    expect(await run(backend, agent, 5_000)).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("keeps polling through leading stale idles (a snapshot wait would return on frame[0])", async () => {
    const backend = new FrameBackend([READY, READY, READY, WORKING, DONE]);
    expect(await run(backend, agent, 5_000)).toEqual({ kind: "completed" });
  });

  it("returns budget-exceeded (NOT a throw) if the pane never leaves the stale idle", async () => {
    const backend = new FrameBackend([READY]);
    expect((await run(backend, agent, 400)).kind).toBe("budget-exceeded");
  });

  it("does NOT complete on the post-submit empty prompt that precedes working", async () => {
    const backend = new FrameBackend([READY, WORKING, WORKING, DONE]);
    expect(await run(backend, agent, 5_000)).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("returns awaiting{dialog} immediately (no transition)", async () => {
    const dialogAgent: AgentDef = {
      ...agent,
      rules: { ...agent.rules, dialog: (t) => t.includes("DIALOG") },
    };
    const backend = new FrameBackend(["DIALOG: choose a theme"]);
    expect(await run(backend, dialogAgent, 5_000)).toEqual({ kind: "awaiting", on: "dialog" });
  });

  it("returns aborted when the pane shows an interrupted turn (restored draft → unknown)", async () => {
    const interruptAgent: AgentDef = {
      ...agent,
      rules: { ...agent.rules, interrupted: (t) => t.includes("Interrupted") },
    };
    const backend = new FrameBackend(["⎿ Interrupted by user\n❯ Write a long essay"]);
    expect(await run(backend, interruptAgent, 5_000)).toEqual({ kind: "aborted" });
  });
});

/**
 * The stateless-CLI fast-turn case (bug 8a500a52): a fast turn can be back to idle
 * before `wait`'s first poll, so no `working` frame is seen. `send` stashes a
 * post-submit fingerprint; `wait` arms on divergence from it.
 */
describe("waitForOutcome — cross-process baseline arm (stateless CLI fast turn)", () => {
  const POST_SUBMIT = "you asked: ping\n❯ ";

  it("arms on divergence when the turn completed before the first poll (no working seen)", async () => {
    const backend = new FrameBackend([DONE], paneFingerprint(POST_SUBMIT));
    expect(await run(backend, agent, 5_000)).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("does NOT arm while the live pane still equals the post-submit baseline", async () => {
    const backend = new FrameBackend(
      [POST_SUBMIT, POST_SUBMIT, WORKING, DONE],
      paneFingerprint(POST_SUBMIT),
    );
    expect(await run(backend, agent, 5_000)).toEqual({ kind: "completed" });
    expect(await backend.capture(ref)).toContain("the answer is 42");
  });

  it("budget-exceeded if the live pane never diverges from the baseline (agent never reacted)", async () => {
    const backend = new FrameBackend([POST_SUBMIT], paneFingerprint(POST_SUBMIT));
    expect((await run(backend, agent, 400)).kind).toBe("budget-exceeded");
  });
});

/**
 * The long-build safety property (S8): a turn that is *legitimately working* must
 * NEVER be early-aborted by the no-progress (`idleMs`) budget, no matter how long
 * it runs — only a genuinely wedged session (a FROZEN, unrecognized pane) trips it.
 * Patience is the CONSUMER's: `idleMs`/`maxMs` are passed via ReadyOpts (the library
 * owns no default), and we pass them tiny here so the contract runs in milliseconds.
 */
describe("waitForOutcome — idle/no-progress budget vs a working turn (S8 / F17)", () => {
  const runStuck = (backend: Backend, ag: AgentDef, maxMs: number, idleMs: number) =>
    waitForOutcome(backend, ref, { maxMs, idleMs }, { stabilize }, reader(backend, ag));

  it("an ANIMATING working pane never trips idleMs — runs to maxMs as `max`, not `idle`", async () => {
    // The live spinner repaints (its elapsed counter ticks), so each frame differs
    // → the progress heartbeat keeps resetting. Even with idleMs far below maxMs,
    // wait() must keep polling and, at maxMs, report `max` (ran out of wall-clock
    // while working) — NOT `idle` (wedged). This is the false-abort guard.
    const frames = Array.from({ length: 60 }, (_, i) => `✻ Working… ${i}s (esc to interrupt)`);
    const backend = new FrameBackend(frames);
    expect(await runStuck(backend, agent, 1_000, 200)).toEqual({
      kind: "budget-exceeded",
      reason: "max",
    });
  });

  it("a FROZEN unrecognized (unknown) pane trips idleMs fast (`idle`)", async () => {
    // Nothing the classifier knows, and the frame never changes → genuinely
    // wedged. Fails fast at idleMs, well before maxMs, labeled `idle`.
    const backend = new FrameBackend(["?? garbled non-prompt non-spinner output"]);
    const t0 = Date.now();
    const out = await runStuck(backend, agent, 10_000, 200);
    expect(out).toEqual({ kind: "budget-exceeded", reason: "idle" });
    expect(Date.now() - t0).toBeLessThan(2_000); // early — did not burn the 10s maxMs
  });

  it("with NO patience supplied, a frozen unknown pane is NOT given up on (library owns no deadline)", async () => {
    // The vision: the library invents no patience. With neither idleMs nor maxMs,
    // a wedged pane is the consumer's problem — wait() keeps polling. We prove it
    // doesn't return within a window that the old library-owned STUCK_MS would have.
    const backend = new FrameBackend(["?? frozen unknown forever"]);
    const settled = await Promise.race([
      waitForOutcome(backend, ref, {}, { stabilize }, reader(backend, agent)).then(
        () => "returned",
      ),
      new Promise((r) => setTimeout(() => r("still-waiting"), 800)),
    ]);
    expect(settled).toBe("still-waiting");
  });

  it("a tool in flight never trips idleMs even with a FROZEN pane (the `!toolInFlight` guard)", async () => {
    // Belief crafted directly: a tool is open (toolInFlight) but the pane reads
    // `unknown` and never changes. The `!toolInFlight` clause must keep wait()
    // polling to maxMs rather than mistaking a long tool for a wedge.
    const frozenToolBelief: Belief = {
      phase: "tool",
      toolInFlight: true,
      transcriptCount: 3,
      hookChannelHealthy: true,
      agentChannelHealthy: true,
      state: "unknown",
      interrupted: false,
    };
    const toolReader: BeliefReader = async () => ({ belief: frozenToolBelief, paneText: "frozen" });
    // The belief is driven directly, so the backend only backs stabilize's capture.
    const backend = new FrameBackend(["frozen"]);
    const t0 = Date.now();
    const out = await waitForOutcome(
      backend,
      ref,
      { maxMs: 600, idleMs: 150 },
      { stabilize },
      toolReader,
    );
    expect(out.kind).toBe("budget-exceeded"); // ran to maxMs, NOT tripped by idleMs
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // burned maxMs, not the idle window
  });
});
