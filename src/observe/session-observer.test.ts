import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import { SessionObserver } from "./session-observer.js";

const userRec = (uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } });
const asstRec = (uuid: string, parent: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: parent,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const PANE = { state: "unknown" as const, interrupted: false };

describe("SessionObserver — incremental belief + thread, hook-resolved transcript path", () => {
  let dir: string;
  let rv: string;
  let tx: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmux-so-"));
    rv = join(dir, "turns.ndjson");
    tx = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves the transcript path from the hook's report, and folds edges + messages incrementally", () => {
    // SessionStart carries the transcript_path → the observer locates the file
    // WITHOUT globbing/locate. Only a session-start edge so far → phase unknown.
    writeFileSync(
      rv,
      `1700000001.0 {"hook_event_name":"SessionStart","transcript_path":"${tx}"}\n`,
    );
    writeFileSync(tx, `${userRec("u1", "hi")}\n`);
    const obs = new SessionObserver({ agent: claude, rendezvousPath: rv });

    let b = obs.belief(PANE, false);
    expect(b.transcriptCount).toBe(1);
    expect(b.phase).toBe("unknown"); // no lifecycle edge yet
    expect(b.hookChannelHealthy).toBe(true);

    // The turn runs: append the lifecycle edges + the reply. The next poll folds
    // only the NEW lines (incremental) into the same caches.
    appendFileSync(
      rv,
      '1700000002.0 {"hook_event_name":"UserPromptSubmit"}\n1700000003.0 {"hook_event_name":"Stop"}\n',
    );
    appendFileSync(tx, `${asstRec("a1", "u1", "PONG")}\n`);

    b = obs.belief(PANE, false);
    expect(b).toMatchObject({
      phase: "done",
      state: "idle", // hook stop → idle (overrides the unknown pane)
      transcriptCount: 2,
      lastStopAt: 1_700_000_003_000,
    });

    const { messages, parentOf } = obs.thread();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(parentOf.get("a1")).toBe("u1"); // the ancestry graph is built
  });

  it("resets its caches when a file shrinks (defensive — append-only in practice)", () => {
    writeFileSync(
      rv,
      `1700000001.0 {"hook_event_name":"SessionStart","transcript_path":"${tx}"}\n`,
    );
    writeFileSync(tx, `${[userRec("u1", "one"), asstRec("a1", "u1", "r1")].join("\n")}\n`);
    const obs = new SessionObserver({ agent: claude, rendezvousPath: rv });
    expect(obs.belief(PANE, false).transcriptCount).toBe(2);

    // Transcript rewritten shorter → the TailReader resets and re-reads from 0.
    writeFileSync(tx, `${userRec("u2", "two")}\n`);
    expect(obs.thread().messages.map((m) => m.id)).toEqual(["u2"]);
  });

  it("no rendezvous (hooks off) → empty edges, belief falls back to the pane", () => {
    const obs = new SessionObserver({ agent: claude });
    const b = obs.belief({ state: "working", interrupted: false }, false);
    expect(b.hookChannelHealthy).toBe(false);
    expect(b.state).toBe("working"); // the pane is the only signal
  });
});
