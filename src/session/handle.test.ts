import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SendPayload } from "../backends/types.js";
import { DELIVERY_UNCONFIRMED, makeHandle } from "./handle.js";

const ctx = claude.transcript;
if (!ctx) throw new Error("claude.transcript must be defined");
const { parseLine, isTurnStart } = ctx;

/** A claude transcript line with explicit thread links. */
const userRec = (uuid: string, parent: string | null, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    ...(parent === null ? {} : { parentUuid: parent }),
    message: { role: "user", content: text },
  });
const asstRec = (uuid: string, parent: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: parent,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("messagesSince — causal-chain isolation (the multi-turn cursor fix)", () => {
  let dir: string;
  let tx: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmux-h-"));
    tx = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agent = (): AgentDef => ({
    name: claude.name,
    buildArgv: claude.buildArgv,
    boot: claude.boot,
    rules: claude.rules,
    transcript: { locate: () => tx, parseLine, isTurnStart },
  });
  const handle = () =>
    makeHandle({
      backend: noopBackend(),
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
  const txt = (msgs: { parts: readonly { kind: string; text?: string }[] }[]) =>
    msgs.flatMap((m) => m.parts.map((p) => p.text ?? "")).join(" ");

  it("isolates a turn from the prior one (cursor=u2 → only turn-2 output)", async () => {
    writeFileSync(
      tx,
      `${[
        userRec("u1", null, "ONE"),
        asstRec("a1", "u1", "reply ONE"),
        userRec("u2", "a1", "TWO"),
        asstRec("a2", "u2", "reply TWO"),
      ].join("\n")}\n`,
    );
    expect(txt(await handle().messagesSince("u2"))).toBe("reply TWO");
    expect(txt(await handle().messagesSince("u1"))).toContain("reply ONE");
    expect(txt(await handle().messagesSince("u1"))).toContain("reply TWO");
  });

  it("ROBUST to worst flush order: prior reply written AFTER our user record", async () => {
    // File order scrambled (a1 flushed late, lands after u2) but parent links are
    // causally correct. A positional slice-after-u2 would leak a1; the chain must not.
    writeFileSync(
      tx,
      `${[
        userRec("u1", null, "ONE"),
        userRec("u2", "a1", "TWO"),
        asstRec("a1", "u1", "reply ONE"),
        asstRec("a2", "u2", "reply TWO"),
      ].join("\n")}\n`,
    );
    expect(txt(await handle().messagesSince("u2"))).toBe("reply TWO"); // a1 excluded despite being later in the file
  });

  it("includes an interleaved human turn (input-source-agnostic)", async () => {
    // After our turn, a human types one (parent = our reply), then the agent answers.
    writeFileSync(
      tx,
      `${[
        userRec("u1", null, "MINE"),
        asstRec("a1", "u1", "ok"),
        userRec("h1", "a1", "HUMAN"),
        asstRec("a2", "h1", "to human"),
      ].join("\n")}\n`,
    );
    expect(txt(await handle().messagesSince("u1"))).toBe("ok HUMAN to human");
  });

  it("thread-less transcript → positional fallback; count + unknown cursors handled", async () => {
    // No parentUuid anywhere → fall back to slicing after the matching id.
    const noLinks = `${[
      userRec("x1", null, "A"),
      '{"type":"assistant","uuid":"x2","message":{"role":"assistant","content":[{"type":"text","text":"B"}]}}',
    ].join("\n")}\n`;
    writeFileSync(tx, noLinks);
    expect(txt(await handle().messagesSince("x1"))).toBe("B");
    // Explicit positional cursor still slices; an UNRESOLVABLE cursor (garbage,
    // or the delivery-unconfirmed sentinel) reads EMPTY — never the whole log (F40).
    writeFileSync(tx, `${[userRec("u1", null, "ONE"), asstRec("a1", "u1", "reply")].join("\n")}\n`);
    expect((await handle().messagesSince("1")).length).toBe(1);
    expect((await handle().messagesSince("nope")).length).toBe(0);
    expect((await handle().messagesSince("delivery-unconfirmed")).length).toBe(0);
  });

  it("turnComplete: true when a reply descends from the cursor, false for a DANGLING turn (S2/F20)", async () => {
    // A completed turn: user → assistant.
    writeFileSync(tx, `${[userRec("u1", null, "ASK"), asstRec("a1", "u1", "REPLY")].join("\n")}\n`);
    expect(await handle().turnComplete("u1")).toBe(true);
    // A crashed/in-flight turn: the prompt is recorded with NO assistant reply.
    writeFileSync(
      tx,
      `${[userRec("u1", null, "DONE"), asstRec("a1", "u1", "ok"), userRec("u2", "a1", "ESSAY")].join("\n")}\n`,
    );
    expect(await handle().turnComplete("u2")).toBe(false); // → the consumer re-sends u2
    expect(await handle().turnComplete("u1")).toBe(true); // the earlier turn DID complete
  });
});

describe("send() → cursor anchoring", () => {
  let dir: string;
  let tx: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmux-h2-"));
    tx = join(dir, "s.jsonl");
    writeFileSync(tx, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agent = (): AgentDef => ({
    name: claude.name,
    buildArgv: claude.buildArgv,
    boot: claude.boot,
    rules: claude.rules,
    transcript: { locate: () => tx, parseLine, isTurnStart },
  });

  it("anchors the cursor on OUR user record (its id), not a count", async () => {
    // The backend records the prompt to the transcript on paste, as claude does.
    let n = 0;
    const recording: Backend = {
      ...noopBackend(),
      send: async (_ref, payload: SendPayload) => {
        if (payload.kind === "paste")
          appendFileSync(tx, `${userRec(`own-${++n}`, null, payload.text)}\n`);
      },
    };
    const h = makeHandle({
      backend: recording,
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    expect(await h.send("hello world")).toBe("own-1"); // the user record's id, not "0"
  });

  it("returns the DELIVERY_UNCONFIRMED sentinel when no user record appears (not a count)", async () => {
    const h = makeHandle({
      backend: noopBackend(),
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    // A count cursor here ("0") would later slice the whole transcript — the
    // sentinel is detectable and reads empty instead (F40).
    expect(await h.send("hello")).toBe(DELIVERY_UNCONFIRMED);
  });
});

function noopBackend(): Backend {
  return {
    id: "fake",
    spawn: async () => undefined,
    kill: async () => undefined,
    exists: async () => true,
    list: async () => [],
    send: async () => undefined,
    capture: async () => "❯ ",
    setSessionMeta: async () => undefined,
    getSessionMeta: async () => undefined,
    onCommand: () => () => undefined,
  };
}
