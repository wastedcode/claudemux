import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { HookEdge } from "../agents/types.js";
import { believe, currentLifeEdges, deriveProgress, readHookEdges } from "./observer.js";

function edge(event: HookEdge["event"], at: number): HookEdge {
  return { event, at };
}

describe("deriveProgress (pure)", () => {
  it("no edges → unknown phase, not healthy", () => {
    const p = deriveProgress({ edges: [], transcriptCount: 0 });
    expect(p).toMatchObject({ phase: "unknown", state: "unknown", hookChannelHealthy: false });
  });

  it("prompt-submit → prompt / working", () => {
    const p = deriveProgress({ edges: [edge("prompt-submit", 1)], transcriptCount: 0 });
    expect(p).toMatchObject({ phase: "prompt", state: "working", toolInFlight: false });
  });

  it("a tool-start with no matching tool-end → tool / toolInFlight (the long-tool case)", () => {
    const p = deriveProgress({
      edges: [edge("prompt-submit", 1), edge("tool-start", 2)],
      transcriptCount: 1,
    });
    expect(p).toMatchObject({ phase: "tool", toolInFlight: true, state: "working" });
  });

  it("tool-start then tool-end → composing, not in flight", () => {
    const p = deriveProgress({
      edges: [edge("prompt-submit", 1), edge("tool-start", 2), edge("tool-end", 3)],
      transcriptCount: 2,
    });
    expect(p).toMatchObject({ phase: "composing", toolInFlight: false, state: "working" });
  });

  it("a stop edge → done / idle (even if a stray earlier tool-start exists)", () => {
    const p = deriveProgress({
      edges: [
        edge("prompt-submit", 1),
        edge("tool-start", 2),
        edge("tool-end", 3),
        edge("stop", 4),
      ],
      transcriptCount: 3,
    });
    expect(p).toMatchObject({ phase: "done", state: "idle", toolInFlight: false });
  });
});

describe("believe — the one fused belief (state()/progress()/wait() defer to it)", () => {
  const pane = (state: Parameters<typeof believe>[0]["pane"]["state"], interrupted = false) => ({
    state,
    interrupted,
  });

  it("pane-only modals WIN over the hook lifecycle (hooks can't see them)", () => {
    // Hooks say a turn is in flight, but the pane shows a permission prompt.
    const b = believe({
      edges: [edge("prompt-submit", 1)],
      transcriptCount: 1,
      pane: pane("permission-prompt"),
    });
    expect(b.state).toBe("permission-prompt");
  });

  it("the reliable hook lifecycle drives state when no modal (idle on stop)", () => {
    const b = believe({
      edges: [edge("prompt-submit", 1), edge("stop", 2)],
      transcriptCount: 2,
      pane: pane("unknown"),
    });
    expect(b.state).toBe("idle");
    expect(b.lastStopAt).toBe(2);
    expect(b.lastActivityAt).toBe(2);
  });

  it("falls back to the pane when the hook channel is silent (off / no turn yet)", () => {
    const b = believe({ edges: [], transcriptCount: 0, pane: pane("working") });
    expect(b.state).toBe("working");
    expect(b.hookChannelHealthy).toBe(false);
  });

  it("an interrupted pane reads `unknown` (stale hook phase ignored) and flags aborted", () => {
    // No `stop` edge (interrupt fires none) so the hook phase is stale 'working'.
    const b = believe({
      edges: [edge("prompt-submit", 1)],
      transcriptCount: 1,
      pane: pane("unknown", /* interrupted */ true),
    });
    expect(b.state).toBe("unknown");
    expect(b.interrupted).toBe(true);
  });

  it("a DENIED tool leaves a dangling tool-start, but a settled idle pane wins (S5/F49)", () => {
    // The deny path: PreToolUse fired `tool-start`, the consumer chose "No", so
    // the tool never ran → NO `tool-end`, NO `stop`. The hook phase is stuck at
    // `tool` (→ working) forever though the turn is over. The pane is the ground
    // truth — a real in-flight tool shows the spinner, not the idle box — so a
    // clean idle pane overrides the stuck hook 'working'.
    const b = believe({
      edges: [edge("prompt-submit", 1), edge("tool-start", 2)],
      transcriptCount: 2,
      pane: pane("idle"),
    });
    expect(b.phase).toBe("tool"); // the raw hook progress is unchanged (tool still "open")
    expect(b.toolInFlight).toBe(true);
    expect(b.state).toBe("idle"); // …but the fused state trusts the settled pane
  });

  it("a GENUINELY in-flight tool (pane shows the spinner) stays working — no false idle", () => {
    // The guard must not fire on a real tool: the pane is 'working' (or unknown),
    // never the idle box, so the hook 'working' stands.
    const b = believe({
      edges: [edge("prompt-submit", 1), edge("tool-start", 2)],
      transcriptCount: 2,
      pane: pane("working"),
    });
    expect(b.state).toBe("working");
  });

  it("a lingering 'Interrupted' during a NEW working turn does NOT count as aborted", () => {
    const b = believe({
      edges: [edge("prompt-submit", 3)],
      transcriptCount: 1,
      pane: pane("working", /* interrupted text still on screen */ true),
    });
    expect(b.interrupted).toBe(false);
    expect(b.state).toBe("working");
  });

  it("resets at the session-start boundary — a prior life's edges DON'T poison the belief (S9/F38)", () => {
    // The reused rendezvous after a crash+resume: the prior life left an unclosed
    // prompt-submit (no stop), then a NEW session-start. The belief must reflect
    // ONLY the current life → no stale 'working'; the idle pane wins.
    const edges = [
      edge("session-start", 1),
      edge("prompt-submit", 2), // prior life's turn …
      edge("prompt-submit", 3), // … crashed mid-turn (NO stop)
      edge("session-start", 9), // resume: a NEW session-start
    ];
    const b = believe({ edges, transcriptCount: 5, pane: pane("idle") });
    expect(b.phase).toBe("unknown"); // no lifecycle edge AFTER the new session-start
    expect(b.state).toBe("idle"); // the stale prompt-submit no longer forces 'working'
    expect(b.lastStopAt).toBeUndefined();
  });

  it("currentLifeEdges keeps everything from the latest session-start; all when none", () => {
    expect(
      currentLifeEdges([edge("stop", 1), edge("session-start", 2), edge("prompt-submit", 3)]).map(
        (e) => e.event,
      ),
    ).toEqual(["session-start", "prompt-submit"]);
    // No session-start at all → a bare progress sequence is kept intact.
    expect(currentLifeEdges([edge("prompt-submit", 1), edge("stop", 2)]).length).toBe(2);
  });

  it("weInterrupted is authoritative — overrides a frozen 'working' pane after interrupt", () => {
    // After interrupt the spinner's 'esc to interrupt' lingers → pane classifies
    // 'working', and the hook has an unclosed prompt-submit. Only the handle knows
    // it issued the interrupt; that flag must win.
    const b = believe({
      edges: [edge("session-start", 1), edge("prompt-submit", 2)],
      transcriptCount: 1,
      pane: pane("working", false),
      weInterrupted: true,
    });
    expect(b.interrupted).toBe(true);
    expect(b.state).toBe("unknown");
  });

  it("a replayed 'Interrupted' on a resumed/idle pane does NOT count as aborted", () => {
    // The resume bug: history replay re-renders the prior turn's "Interrupted",
    // but the box is idle (a completed turn) — it is scrollback, not a current abort.
    const b = believe({
      edges: [edge("prompt-submit", 1), edge("stop", 2)],
      transcriptCount: 2,
      pane: pane("idle", /* stale Interrupted in scrollback */ true),
    });
    expect(b.interrupted).toBe(false);
    expect(b.state).toBe("idle");
  });
});

describe("believe — agentChannelHealthy drift canary (S16/F50)", () => {
  it("UNHEALTHY only when ALL channels are blind against a non-empty pane", () => {
    // Pane has content but classifies `unknown`, no hook edges, no messages → the
    // triple-blind drift signature.
    const b = believe({
      edges: [],
      transcriptCount: 0,
      pane: { state: "unknown", interrupted: false, nonEmpty: true },
    });
    expect(b.agentChannelHealthy).toBe(false);
  });

  it("a recognized pane state keeps it healthy (the classifier read something)", () => {
    const b = believe({
      edges: [],
      transcriptCount: 0,
      pane: { state: "idle", interrupted: false, nonEmpty: true },
    });
    expect(b.agentChannelHealthy).toBe(true);
  });

  it("any single live channel keeps it healthy — a hook edge, or parsed messages", () => {
    const viaHook = believe({
      edges: [edge("session-start", 1)],
      transcriptCount: 0,
      pane: { state: "unknown", interrupted: false, nonEmpty: true },
    });
    expect(viaHook.agentChannelHealthy).toBe(true);
    const viaTranscript = believe({
      edges: [],
      transcriptCount: 5,
      pane: { state: "unknown", interrupted: false, nonEmpty: true },
    });
    expect(viaTranscript.agentChannelHealthy).toBe(true);
  });

  it("an EMPTY/blank pane is never judged drifted (no content to be blind to)", () => {
    const b = believe({
      edges: [],
      transcriptCount: 0,
      pane: { state: "unknown", interrupted: false, nonEmpty: false },
    });
    expect(b.agentChannelHealthy).toBe(true);
  });
});

describe("readHookEdges (the boot-ready signal source)", () => {
  it("returns the session-start edge chronologically; absent file → empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-edges-"));
    try {
      const rv = join(dir, "turns.ndjson");
      // Out of file order on purpose — readHookEdges sorts by time.
      writeFileSync(
        rv,
        [
          '1700000002.0 {"hook_event_name":"UserPromptSubmit"}',
          '1700000001.0 {"hook_event_name":"SessionStart","source":"startup"}',
        ].join("\n"),
      );
      const edges = readHookEdges({ agent: claude, rendezvousPath: rv });
      expect(edges.map((e) => e.event)).toEqual(["session-start", "prompt-submit"]);
      expect(edges.some((e) => e.event === "session-start")).toBe(true);
      // Absent file degrades to empty (boot then waits on the pane fallback).
      expect(readHookEdges({ agent: claude, rendezvousPath: "/nope/x.ndjson" })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deriveProgress — composing boundary", () => {
  it("a sequence ending on tool-end derives phase=composing", () => {
    const p = deriveProgress({
      edges: [edge("prompt-submit", 1), edge("tool-start", 2), edge("tool-end", 3)],
      transcriptCount: 2,
    });
    expect(p).toMatchObject({ phase: "composing", toolInFlight: false, state: "working" });
  });
});
