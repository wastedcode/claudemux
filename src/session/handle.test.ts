import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { makeHandle } from "./handle.js";

/**
 * Round-trip test for the turn contract — send()→Cursor and messagesSince() —
 * the headline surface, driven through a fake backend + a fake transcript whose
 * file we grow to simulate a turn producing output.
 */

const ctx = claude.transcript;
if (!ctx) throw new Error("claude.transcript must be defined");
const { parseLine, isTurnStart } = ctx;

/** A no-op backend; the handle only needs capture/send/kill/onCommand here. */
function fakeBackend(): Backend {
  return {
    id: "fake",
    spawn: async () => undefined,
    kill: async () => undefined,
    exists: async () => true,
    list: async () => [],
    send: async () => undefined, // sendOnce's paste + Enter — no-op
    capture: async () => "❯ ", // a benign ready-ish pane
    setSessionMeta: async () => undefined,
    getSessionMeta: async () => undefined,
    onCommand: () => () => undefined,
  };
}

describe("handle — send()→Cursor / messagesSince round-trip", () => {
  let transcriptFile: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmux-handle-"));
    transcriptFile = join(dir, "session.jsonl");
    writeFileSync(transcriptFile, ""); // starts empty (no turns yet)
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A real claude AgentDef but with transcript.locate pinned to our temp file.
  function agent(): AgentDef {
    return {
      name: claude.name,
      buildArgv: claude.buildArgv,
      boot: claude.boot,
      rules: claude.rules,
      transcript: { locate: () => transcriptFile, parseLine, isTurnStart },
    };
  }

  function handle() {
    return makeHandle({
      backend: fakeBackend(),
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id-1",
    });
  }

  const USER = '{"type":"user","message":{"role":"user","content":"ping"},"uuid":"u1"}';
  const REPLY =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}]},"uuid":"a1"}';

  it("send() anchors the cursor at the pre-send message count", async () => {
    // No messages yet → cursor "0".
    expect(await handle().send("ping")).toBe("0");
    // With one prior message, the next send anchors at "1".
    writeFileSync(transcriptFile, USER);
    expect(await handle().send("again")).toBe("1");
  });

  it("messagesSince(cursor) returns only the tail produced after the send", async () => {
    const h = handle();
    const cursor = await h.send("ping"); // "0" — transcript empty at send
    // The turn produces the user echo + the assistant reply.
    writeFileSync(transcriptFile, `${USER}\n${REPLY}`);
    const msgs = await h.messagesSince(cursor);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]?.parts).toEqual([{ kind: "text", text: "PONG" }]);
  });

  it("a non-zero cursor slices correctly; a garbage cursor returns all", async () => {
    writeFileSync(transcriptFile, `${USER}\n${REPLY}`);
    const h = handle();
    expect((await h.messagesSince("1")).map((m) => m.role)).toEqual(["assistant"]);
    expect((await h.messagesSince("abc")).map((m) => m.role)).toEqual(["user", "assistant"]); // fallback: all
    expect((await h.messagesSince("-1")).map((m) => m.role)).toEqual(["user", "assistant"]); // fallback: all
  });

  it("progress() reflects the transcript count even with no hook channel", async () => {
    writeFileSync(transcriptFile, `${USER}\n${REPLY}`);
    const p = await handle().progress();
    expect(p.transcriptCount).toBe(2);
    // No rendezvous markers here → hook channel not healthy, phase unknown.
    expect(p.hookChannelHealthy).toBe(false);
  });
});
