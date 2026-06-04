/**
 * SURFACE acceptance — exercises EVERY public library surface end-to-end against
 * a live claude, not just the core turn loop. Run (after `npm run build`):
 *   CLAUDEMUX_SOCKET=cmux-surface node scripts/surface-library.mjs
 *
 * Covers: exists · list · create · ask (round-trip) · wait→TurnOutcome ·
 * send+messagesSince · state · progress · capture · interrupt · adopt · resume
 * (proves history continuity) · kill. Isolated socket; every session self-killed.
 */
import { mkdirSync } from "node:fs";
import { adopt, ask, create, exists, kill, list, resume } from "../dist/index.js";

const CWD = "/tmp/cmux-surface";
mkdirSync(CWD, { recursive: true });
const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const txt = (msgs) => msgs.flatMap((m) => m.parts.map((p) => p.text ?? "")).join(" ");
const NS = "cmux-surf";
const opts = (name) => ({
  name,
  namespace: NS,
  cwd: CWD,
  trustWorkspace: true,
  bootTimeoutMs: 60_000,
});

async function main() {
  const a = `surf-a-${Date.now().toString(36)}`;

  // ── registry: exists(missing) ───────────────────────────────────────────
  rec(
    "exists() is false for a missing session",
    (await exists({ name: a, namespace: NS })) === false,
  );

  // ── create + exists + list ──────────────────────────────────────────────
  const s = await create(opts(a));
  rec(
    "create() returns a handle with an agentSessionId",
    typeof s.agentSessionId === "string",
    s.agentSessionId,
  );
  rec("exists() is true after create", (await exists({ name: a, namespace: NS })) === true);
  rec("list() includes the created session", (await list({ namespace: NS })).includes(a));

  // ── ask(): the Q&A round-trip composer ──────────────────────────────────
  const r1 = await ask(s, "Remember this secret word for later: BANANA. Reply with exactly: OK");
  rec(
    "ask() returns outcome.kind === 'completed'",
    r1.outcome.kind === "completed",
    JSON.stringify(r1.outcome),
  );
  rec("ask() returns a cursor", typeof r1.cursor === "string");
  rec(
    "ask() returns the reply messages",
    txt(r1.messages).includes("OK"),
    txt(r1.messages).slice(0, 40),
  );

  // ── send + wait→TurnOutcome + messagesSince ─────────────────────────────
  const c = await s.send("Reply with exactly the single word: PING");
  const outcome = await s.wait();
  rec(
    "wait() returns a TurnOutcome { kind: 'completed' }",
    outcome.kind === "completed",
    JSON.stringify(outcome),
  );
  const since = await s.messagesSince(c);
  rec(
    "messagesSince(cursor) isolates this turn's reply",
    txt(since).includes("PING") && !txt(since).includes("PONG"),
    txt(since).slice(0, 40),
  );

  // ── state + progress + capture ──────────────────────────────────────────
  rec("state() returns a string verdict", typeof (await s.state()) === "string", await s.state());
  const p = await s.progress();
  rec(
    "progress() reports phase + hookChannelHealthy",
    typeof p.phase === "string" && p.hookChannelHealthy === true,
    `${p.phase}/${p.hookChannelHealthy}`,
  );
  rec("capture() returns pane text", (await s.capture()).length > 0);

  // ── adopt(): re-attach recovers the same id ─────────────────────────────
  const ad = await adopt({ name: a, namespace: NS });
  rec(
    "adopt() recovers the same agentSessionId",
    ad.agentSessionId === s.agentSessionId,
    ad.agentSessionId,
  );

  // ── interrupt(): stop a long turn, then it's responsive ─────────────────
  await s.send("Write a long 400-word essay about the history of Unix. Output it directly.");
  await new Promise((r) => setTimeout(r, 4000));
  await s.interrupt();
  await new Promise((r) => setTimeout(r, 2500));
  rec(
    "interrupt() leaves the session responsive (state is a string)",
    typeof (await s.state()) === "string",
  );

  // ── resume(): continue the conversation in a FRESH pane (history proof) ──
  const planted = s.agentSessionId;
  await s.kill(); // free the id (claude refuses to resume an in-use conversation)
  await new Promise((r) => setTimeout(r, 500));
  const b = `surf-b-${Date.now().toString(36)}`;
  const s2 = await resume({
    name: b,
    namespace: NS,
    cwd: CWD,
    agentSessionId: planted,
    trustWorkspace: true,
    bootTimeoutMs: 60_000,
  });
  rec(
    "resume() surfaces the resumed conversation id",
    s2.agentSessionId === planted,
    s2.agentSessionId,
  );
  const r2 = await ask(
    s2,
    "What was the secret word I told you to remember? Reply with just that word.",
  );
  rec(
    "resume() continued the SAME conversation (recalls the secret)",
    txt(r2.messages).includes("BANANA"),
    txt(r2.messages).slice(0, 40),
  );

  // ── kill(): gone afterwards ─────────────────────────────────────────────
  await s2.kill();
  await new Promise((r) => setTimeout(r, 400));
  rec(
    "kill() — exists() is false afterwards",
    (await exists({ name: b, namespace: NS })) === false,
  );
}

try {
  await main();
} catch (e) {
  rec("surface run threw", false, String(e?.stack ?? e));
} finally {
  // Safety net: kill anything we might have left on this isolated namespace.
  for (const n of await list({ namespace: NS }).catch(() => [])) {
    await kill({ name: n, namespace: NS }).catch(() => undefined);
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`LIBRARY SURFACE: ${pass}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
console.log(`${"=".repeat(56)}\n`);
process.exit(pass === results.length ? 0 : 1);
