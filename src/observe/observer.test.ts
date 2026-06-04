import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { HookEdge } from "../agents/types.js";
import {
  assembleBelief,
  believe,
  currentLifeEdges,
  deriveProgress,
  observeProgress,
  readHookEdges,
  readMessages,
} from "./observer.js";

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

describe("observeProgress + readMessages (fs, via the agent seam)", () => {
  it("reads the rendezvous + transcript and fuses a Progress; reads messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-obs-"));
    try {
      // A real turn's markers (ts-prefixed, as the hook writes them).
      const rv = join(dir, "turns.ndjson");
      writeFileSync(
        rv,
        [
          '1780520910.70 {"hook_event_name":"SessionStart"}',
          '1780520911.00 {"hook_event_name":"UserPromptSubmit"}',
          '1780520912.28 {"hook_event_name":"Stop"}',
        ].join("\n"),
      );
      // A transcript with one user turn + one assistant reply + a metadata line.
      const tx = join(dir, "session.jsonl");
      writeFileSync(
        tx,
        [
          '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}]},"uuid":"a1"}',
          '{"type":"file-history-snapshot","uuid":"m1"}',
        ].join("\n"),
      );

      const p = observeProgress({ agent: claude, rendezvousPath: rv, transcriptPath: tx });
      expect(p).toMatchObject({ phase: "done", state: "idle", hookChannelHealthy: true });
      expect(p.transcriptCount).toBe(2); // the metadata line is not a message

      const msgs = readMessages({ agent: claude, transcriptPath: tx });
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs[1]?.parts).toEqual([{ kind: "text", text: "PONG" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing files degrade to unknown/empty — never throws", () => {
    const p = observeProgress({
      agent: claude,
      rendezvousPath: "/nope/x.ndjson",
      transcriptPath: "/nope/y.jsonl",
    });
    expect(p).toMatchObject({ phase: "unknown", hookChannelHealthy: false, transcriptCount: 0 });
    expect(readMessages({ agent: claude, transcriptPath: "/nope/y.jsonl" })).toEqual([]);
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

describe("assembleBelief (wires hook + transcript reads, fuses with the pane)", () => {
  it("reads edges + transcript count from disk and fuses with the pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-belief-"));
    try {
      const rv = join(dir, "turns.ndjson");
      writeFileSync(
        rv,
        [
          '1700000001.0 {"hook_event_name":"UserPromptSubmit"}',
          '1700000002.0 {"hook_event_name":"Stop"}',
        ].join("\n"),
      );
      const tx = join(dir, "s.jsonl");
      writeFileSync(
        tx,
        [
          '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}',
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]},"uuid":"a1"}',
        ].join("\n"),
      );
      const b = assembleBelief({
        agent: claude,
        rendezvousPath: rv,
        transcriptPath: tx,
        pane: { state: "unknown", interrupted: false },
      });
      expect(b).toMatchObject({
        state: "idle",
        phase: "done",
        transcriptCount: 2,
        lastStopAt: 1_700_000_002_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("observeProgress — composing boundary + out-of-order edge sorting", () => {
  it("a rendezvous ending on PostToolUse derives phase=composing (via the real fs path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-obs2-"));
    try {
      const rv = join(dir, "turns.ndjson");
      writeFileSync(
        rv,
        [
          '1700000001.0 {"hook_event_name":"UserPromptSubmit"}',
          '1700000002.0 {"hook_event_name":"PreToolUse","tool_name":"Bash"}',
          '1700000003.0 {"hook_event_name":"PostToolUse","tool_name":"Bash"}',
        ].join("\n"),
      );
      const p = observeProgress({ agent: claude, rendezvousPath: rv });
      expect(p).toMatchObject({ phase: "composing", toolInFlight: false, state: "working" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives phase from the latest edge BY TIME, not by file order (writes can race)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-obs3-"));
    try {
      const rv = join(dir, "turns.ndjson");
      // Stop (latest by time) written BEFORE an earlier prompt-submit line.
      writeFileSync(
        rv,
        [
          '1700000009.0 {"hook_event_name":"Stop"}',
          '1700000001.0 {"hook_event_name":"UserPromptSubmit"}',
        ].join("\n"),
      );
      expect(observeProgress({ agent: claude, rendezvousPath: rv }).phase).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
