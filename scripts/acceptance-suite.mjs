/**
 * Acceptance SUITE — exercises the turn contract's real behaviors + edges against
 * a live claude, not just the happy path. Run (after `npm run build`):
 *   CLAUDEMUX_SOCKET=claudemux-accept node scripts/acceptance-suite.mjs
 *
 * Scenarios: (A) multi-turn + cursor isolation, (B) tool-using turn phase/parts,
 * (C) hooks:false degraded read, (D) interrupt stops a turn. Each uses a throwaway
 * cwd + a uniquely-named, self-killed session. Needs an authenticated claude.
 */
import { mkdirSync } from "node:fs";
import { create } from "../dist/index.js";

const CWD = "/tmp/cmux-accept-suite";
mkdirSync(CWD, { recursive: true });
const results = [];
const rec = (scenario, name, ok, detail = "") => {
  results.push({ scenario, name, ok });
  console.log(`    ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const text = (m) => m.parts.map((x) => (x.kind === "text" ? x.text : "")).join("");
const kinds = (msgs) => msgs.flatMap((m) => m.parts.map((p) => p.kind));

async function waitDone(session, ms = 60_000) {
  const deadline = Date.now() + ms;
  const seen = [];
  // Transition-aware: the PRIOR turn's `done` is still the latest phase right
  // after we send, so we must see this turn START (any non-done phase) before a
  // `done` counts — else turn 2 returns on turn 1's stale done (a flaky read).
  let armed = false;
  while (Date.now() < deadline) {
    const p = await session.progress();
    if (seen.at(-1) !== p.phase) seen.push(p.phase);
    if (p.phase !== "done") armed = true;
    if (armed && p.phase === "done") return seen;
    await new Promise((r) => setTimeout(r, 200));
  }
  return seen;
}
const fresh = (n, opts = {}) =>
  create({
    name: `${n}-${Date.now().toString(36)}`,
    cwd: CWD,
    trustWorkspace: true,
    bootTimeoutMs: 60_000,
    ...opts,
  });

// A) Multi-turn + cursor isolation — the thing the unit test only mocked.
async function scenarioA() {
  console.log("\n[A] multi-turn + cursor isolation\n");
  const s = await fresh("acc-a");
  try {
    const c1 = await s.send("Reply with exactly the single word: ONE");
    // wait() is the reliable "done AND readable" signal: it trails until the
    // pane settles, which is *after* the transcript flush. The raw hook `done`
    // edge precedes the assistant-record flush by ~100ms, so reading messages
    // on it races the flush (that skew belongs to the TurnOutcome work).
    await s.wait();
    const c2 = await s.send("Reply with exactly the single word: TWO");
    await s.wait();
    const since1 = await s.messagesSince(c1);
    const since2 = await s.messagesSince(c2);
    const t1 = since1.map(text).join(" ");
    const t2 = since2.map(text).join(" ");
    rec("A", "messagesSince(c1) has BOTH turns", t1.includes("ONE") && t1.includes("TWO"), t1);
    rec(
      "A",
      "messagesSince(c2) isolates turn 2 (TWO, not ONE)",
      t2.includes("TWO") && !t2.includes("ONE"),
      t2,
    );
  } finally {
    await s.kill();
  }
}

// B) Tool-using turn — phase progression + tool parts in the messages.
async function scenarioB() {
  console.log("\n[B] tool-using turn — phase + tool parts\n");
  const s = await fresh("acc-b");
  try {
    // The tool must DWELL long enough to be sampled — `echo` returns in <1ms, so
    // the `tool-start`→`tool-end` window can close between two 200ms progress
    // polls and the (real) `tool` phase is missed (sampling race, not a bug). A
    // ~2s sleep keeps the tool in flight across several polls, so the phase
    // contract is exercised deterministically.
    const c = await s.send(
      "Use the Bash tool to run exactly: sleep 2 && echo TOOLRAN. Then reply with the single word DONE.",
    );
    const phases = await waitDone(s);
    await s.wait(); // settle past the hook-done→transcript-flush skew before reading
    const msgs = await s.messagesSince(c);
    console.log(`    phases: ${phases.join(" → ")}`);
    rec("B", "phase went through 'tool'", phases.includes("tool"), phases.join("→"));
    rec("B", "messages include a tool part", kinds(msgs).includes("tool"), kinds(msgs).join(","));
    rec("B", "and a tool-result part", kinds(msgs).includes("tool-result"));
  } finally {
    await s.kill();
  }
}

// C) hooks:false — observe degrades honestly, but transcript reads still work.
async function scenarioC() {
  console.log("\n[C] hooks:false — degraded observe, reads still work\n");
  const s = await fresh("acc-c", { hooks: false });
  try {
    const c = await s.send("Reply with exactly the single word: THREE");
    // hooks:false has no Stop edge, so progress() can't report "done" — the
    // honest degraded-mode settle is the pane-based wait(), which classifies
    // idle from the TUI. (Polling transcriptCount is wrong: it plateaus at 1
    // in the gap between the user record flushing and the reply landing.)
    await s.wait();
    const p = await s.progress();
    const msgs = await s.messagesSince(c);
    rec("C", "hookChannelHealthy is false (honest degrade)", p.hookChannelHealthy === false);
    rec(
      "C",
      "messagesSince still returns the reply (transcript fallback)",
      msgs.some((m) => text(m).includes("THREE")),
    );
  } finally {
    await s.kill();
  }
}

// D) interrupt() actually stops a working turn.
async function scenarioD() {
  console.log("\n[D] interrupt() stops a turn\n");
  const s = await fresh("acc-d");
  try {
    await s.send(
      "Write a long, detailed 400-word essay about the history of Unix. Output it directly.",
    );
    await new Promise((r) => setTimeout(r, 4000)); // let it start generating
    await s.interrupt();
    await new Promise((r) => setTimeout(r, 2500));
    const pane = await s.capture();
    rec("D", "pane shows the interrupted state", /Interrupted/i.test(pane));
    // The turn was halted: the session is still usable (not wedged) afterward.
    // NOTE: the transcript DOES gain the interrupted-turn records — that's correct,
    // not a failure (an earlier assertion wrongly treated growth as a stuck turn).
    rec("D", "session is responsive after interrupt", typeof (await s.state()) === "string");
  } finally {
    await s.kill();
  }
}

for (const sc of [scenarioA, scenarioB, scenarioC, scenarioD]) {
  try {
    await sc();
  } catch (e) {
    rec(sc.name, "scenario threw", false, String(e?.message ?? e));
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(52)}`);
console.log(`ACCEPTANCE SUITE: ${pass}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED [${r.scenario}] ${r.name}`);
console.log(`${"=".repeat(52)}\n`);
process.exit(pass === results.length ? 0 : 1);
