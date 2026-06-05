import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SendPayload } from "../backends/types.js";
import { PromptResponseUnsupported, TranscriptUnlocatable } from "../errors.js";
import { DELIVERED_QUEUED, DELIVERY_UNCONFIRMED, makeHandle } from "./handle.js";

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

  it("compaction defense: an orphaned chain (parent record dropped) still includes the post-cursor tail (S13/F43)", async () => {
    // On real claude the chain stays intact across a compaction (verified live).
    // This guards the hypothetical where an intermediate record is GONE: u2's
    // parent points at a summarized-away id, so the chain from u2 can't reach u1.
    // u2/a2 sit AFTER u1 in the file, so they must still be returned (we can't
    // prove causality through the hole → fall back to position).
    writeFileSync(
      tx,
      `${[
        userRec("u1", null, "ONE"),
        asstRec("a1", "u1", "reply ONE"),
        userRec("u2", "GONE-summarized", "POSTCOMPACT"), // parent record not in the file
        asstRec("a2", "u2", "reply POST"),
      ].join("\n")}\n`,
    );
    expect(txt(await handle().messagesSince("u1"))).toContain("reply POST"); // orphan tail kept
    expect(txt(await handle().messagesSince("u2"))).toBe("reply POST"); // cursor on the orphan works

    // And the late-flush reply (clean root BEFORE the cursor) is still excluded —
    // it is NOT an orphan, so position never leaks it in.
    writeFileSync(
      tx,
      `${[
        userRec("u1", null, "ONE"),
        userRec("u2", "a1", "TWO"),
        asstRec("a1", "u1", "reply ONE"), // flushed late, lands after u2
        asstRec("a2", "u2", "reply TWO"),
      ].join("\n")}\n`,
    );
    expect(txt(await handle().messagesSince("u2"))).toBe("reply TWO"); // a1 still excluded
  });

  it("throws TranscriptUnlocatable for a NO-ID session (blind reads, not deceptive empty) (F46)", async () => {
    // No agentSessionId AND no hook rendezvous → the transcript is unaddressable.
    // messagesSince/turnComplete must throw, NOT return []/false (which in a
    // re-send path would re-run a turn that actually completed).
    const blind = makeHandle({
      backend: noopBackend(),
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      // intentionally NO agentSessionId
    });
    await expect(blind.messagesSince("u1")).rejects.toBeInstanceOf(TranscriptUnlocatable);
    await expect(blind.turnComplete("u1")).rejects.toBeInstanceOf(TranscriptUnlocatable);

    // A LOCATABLE session (id present) with a genuinely empty/unmatched cursor
    // still returns the benign empty — only true unlocatability throws.
    writeFileSync(tx, `${[userRec("u1", null, "ONE"), asstRec("a1", "u1", "reply")].join("\n")}\n`);
    expect((await handle().messagesSince("nope")).length).toBe(0); // bad cursor → [], no throw
    expect(await handle().turnComplete("u1")).toBe(true); // locatable → honest answer
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

  it("returns DELIVERED_QUEUED (not UNCONFIRMED) when sent into a BUSY session that queued it (S4)", async () => {
    // No user record flushes (the queued turn hasn't started), but the pane shows
    // claude's queue affordance — so the message is accepted, not lost. The
    // consumer must NOT re-send: a distinct sentinel keeps it from double-running.
    const busyQueued: Backend = {
      ...noopBackend(),
      capture: async () => "❯ Press up to edit queued messages\n  esc to interrupt",
    };
    const h = makeHandle({
      backend: busyQueued,
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    expect(await h.send("Reply with TWO")).toBe(DELIVERED_QUEUED);
    // And both sentinels resolve EMPTY (the record doesn't exist yet) — never a flood.
    expect((await h.messagesSince(DELIVERED_QUEUED)).length).toBe(0);
  });

  it("recovers a LOST submit by re-firing Enter once (paste landed, first Enter dropped) (S3)", async () => {
    // Simulate the lost-Enter race: the paste reaches the composer, but the FIRST
    // Enter is dropped (no submit, no record). send() must re-fire Enter (never
    // re-paste) and recover a real cursor — not DELIVERY_UNCONFIRMED.
    let enters = 0;
    let pending: string | null = null;
    let submitted = false;
    const flaky: Backend = {
      ...noopBackend(),
      // The composer shows the un-submitted draft (classifies `unknown`) until the
      // recovery Enter submits it — this is the pane signature the gate keys on.
      capture: async () => (submitted ? "❯ " : "❯ hello world"),
      send: async (_ref, payload: SendPayload) => {
        if (payload.kind === "paste") {
          pending = payload.text; // the draft now sits in the composer…
        } else if (payload.kind === "key" && payload.key === "Enter") {
          enters++;
          if (enters >= 2 && pending !== null) {
            // …only the SECOND Enter (the recovery) actually submits it.
            appendFileSync(tx, `${userRec("own-1", null, pending)}\n`);
            pending = null;
            submitted = true;
          }
        }
      },
    };
    const h = makeHandle({
      backend: flaky,
      agent: agent(),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    expect(await h.send("hello world")).toBe("own-1"); // recovered, NOT unconfirmed
    expect(enters).toBe(2); // exactly one retry Enter — never a re-paste
  });
});

describe("respond() → permission-prompt answer (S5)", () => {
  const txAgent = (tx: string): AgentDef => ({
    name: claude.name,
    buildArgv: claude.buildArgv,
    boot: claude.boot,
    rules: claude.rules,
    permissionPrompt: { respondKey: (c) => (c === "approve" ? "1" : c === "deny" ? "3" : "2") },
    transcript: { locate: () => tx, parseLine, isTurnStart },
  });

  it("fires the digit the agent maps each neutral choice to (approve→1, session→2, deny→3)", async () => {
    const keys: string[] = [];
    const recording: Backend = {
      ...noopBackend(),
      send: async (_ref, payload: SendPayload) => {
        if (payload.kind === "key") keys.push(payload.key);
      },
    };
    const h = makeHandle({
      backend: recording,
      agent: txAgent("/nope.jsonl"),
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    await h.respond("approve");
    await h.respond("approve-for-session");
    await h.respond("deny");
    // No Enter is appended — a bare digit selects-and-confirms on claude 2.1.162.
    expect(keys).toEqual(["1", "2", "3"]);
  });

  it("throws PromptResponseUnsupported for an agent that declares no menu mapping", async () => {
    const agentNoPrompt: AgentDef = {
      name: "codex-ish",
      buildArgv: claude.buildArgv,
      boot: claude.boot,
      rules: claude.rules,
      // no permissionPrompt mapping
    };
    const h = makeHandle({
      backend: noopBackend(),
      agent: agentNoPrompt,
      namespace: "claudemux",
      name: "t",
      agentSessionId: "id",
    });
    await expect(h.respond("approve")).rejects.toBeInstanceOf(PromptResponseUnsupported);
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
