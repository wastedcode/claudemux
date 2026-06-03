import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { HookEdge } from "../agents/types.js";
import { deriveProgress, observeProgress, readMessages } from "./observer.js";

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
