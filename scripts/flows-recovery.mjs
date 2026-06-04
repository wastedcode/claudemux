/**
 * RECOVERY-FLOW acceptance — the gnarly flows from docs/design/user-flows.md,
 * exercised FOR REAL against a live claude (it actually kills the tmux server
 * mid-turn, etc.) — not superficial return-type checks. Run (after `npm build`):
 *   CLAUDEMUX_SOCKET=cmux-flows node scripts/flows-recovery.mjs
 *
 * Codifies: F19 clean resume · F20 crash-mid-turn→resume (state + turnComplete +
 * what-to-re-send) · F21 adopt (pane survived) · F28 interrupt→aborted ·
 * F30 interrupt scrollback guard. Isolated socket; every session killed.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { adopt, create, exists, kill, list, resume } from "../dist/index.js";

const SOCK = process.env.CLAUDEMUX_SOCKET ?? "cmux-flows";
const CWD = "/tmp/cmux-flows";
mkdirSync(CWD, { recursive: true });
const NS = "cmux-flows";
const results = [];
const rec = (flow, name, ok, detail = "") => {
  results.push({ flow, name, ok });
  console.log(`  ${ok ? "✅" : "❌"} [${flow}] ${name}${detail ? ` — ${String(detail).slice(0, 50)}` : ""}`);
};
const txt = (m) => m.flatMap((x) => x.parts.map((p) => p.text ?? "")).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (name) => ({ name, namespace: NS, cwd: CWD, trustWorkspace: true, bootTimeoutMs: 60_000 });

// F19 — clean resume continues the same conversation.
async function f19() {
  const a = `f19-${Date.now().toString(36)}`;
  const s = await create(opts(a));
  const id = s.agentSessionId;
  await s.send("Remember the secret word: MANGO. Reply OK."); await s.wait();
  await s.kill(); await sleep(500);
  const s2 = await resume({ ...opts(`f19b-${Date.now().toString(36)}`), agentSessionId: id });
  const c = await s2.send("What was the secret word? One word."); await s2.wait();
  rec("F19", "clean resume recalls the conversation", txt(await s2.messagesSince(c)).includes("MANGO"));
  await s2.kill();
}

// F20 — crash MID-TURN (kill the tmux server), then resume; the standardized contract.
async function f20() {
  const a = `f20-${Date.now().toString(36)}`;
  const s = await create(opts(a));
  const id = s.agentSessionId;
  const cPlant = await s.send("Remember the secret word: PEACH. Reply OK."); await s.wait();
  const cEssay = await s.send("Write a detailed 600-word essay about Unix history. Output it now.");
  await sleep(4500); // generating
  execSync(`tmux -L ${SOCK} -f /dev/null kill-server`); // ← real crash, mid-turn
  await sleep(500);
  rec("F20", "exists() flips to false after the crash", (await exists({ name: a, namespace: NS })) === false);
  const s2 = await resume({ ...opts(`f20b-${Date.now().toString(36)}`), agentSessionId: id });
  rec("F20", "post-resume state is idle, NOT a stale 'working' (S9)", (await s2.state()) === "idle", await s2.state());
  rec("F20", "turnComplete(in-flight cursor) === false → re-send it (S2)", (await s2.turnComplete(cEssay)) === false);
  rec("F20", "turnComplete(earlier cursor) === true → don't re-send it", (await s2.turnComplete(cPlant)) === true);
  // what-to-re-send: the incomplete prompt. Re-sending it completes cleanly.
  const cRetry = await s2.send("Write a 3-word note about Unix. Output it now.");
  const out = await s2.wait();
  rec("F20", "re-sent in-flight prompt completes; history (PEACH) intact", out.kind === "completed" && (await s2.turnComplete(cRetry)) === true);
  const c = await s2.send("What was the secret word? One word."); await s2.wait();
  rec("F20", "the pre-crash conversation survived the crash+resume", txt(await s2.messagesSince(c)).includes("PEACH"));
  await s2.kill();
}

// F21 — consumer restart, pane SURVIVED: adopt recovers id + transcript.
async function f21() {
  const a = `f21-${Date.now().toString(36)}`;
  const s = await create(opts(a));
  const c = await s.send("Reply with exactly the single word: ADOPTED"); await s.wait();
  const ad = await adopt({ name: a, namespace: NS }); // simulate a fresh process re-attaching
  rec("F21", "adopt recovers the same agentSessionId", ad.agentSessionId === s.agentSessionId);
  rec("F21", "adopted handle reads the transcript (id recovered, not degraded)", txt(await ad.messagesSince(c)).includes("ADOPTED"));
  await s.kill();
}

// F28 — interrupt a working turn → aborted.
async function f28() {
  const a = `f28-${Date.now().toString(36)}`;
  const s = await create(opts(a));
  await s.send("Write a long 400-word essay about Unix. Output it directly.");
  await sleep(4000);
  await s.interrupt();
  const out = await s.wait();
  rec("F28", "wait() after interrupt resolves { kind: 'aborted' }", out.kind === "aborted", JSON.stringify(out));
  await s.kill();
}

// F30 — after an interrupt, a NEW turn completes (the scrollback "Interrupted" must NOT false-abort).
async function f30() {
  const a = `f30-${Date.now().toString(36)}`;
  const s = await create(opts(a));
  await s.send("Write a long 400-word essay about Unix. Output it directly.");
  await sleep(4000);
  await s.interrupt(); await sleep(1500);
  const c = await s.send("Reply with exactly the single word: RECOVERED");
  const out = await s.wait();
  rec("F30", "a NEW turn after interrupt completes (no false abort from scrollback)", out.kind === "completed" && txt(await s.messagesSince(c)).includes("RECOVERED"), JSON.stringify(out));
  await s.kill();
}

for (const [name, fn] of [["F19", f19], ["F20", f20], ["F21", f21], ["F28", f28], ["F30", f30]]) {
  try {
    await fn();
  } catch (e) {
    rec(name, "flow threw", false, String(e?.message ?? e));
  }
}
for (const n of await list({ namespace: NS }).catch(() => [])) {
  await kill({ name: n, namespace: NS }).catch(() => undefined);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(58)}`);
console.log(`RECOVERY FLOWS: ${pass}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED [${r.flow}] ${r.name}`);
console.log(`${"=".repeat(58)}\n`);
process.exit(pass === results.length ? 0 : 1);
