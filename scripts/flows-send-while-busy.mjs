/**
 * Send-while-busy acceptance (S4 / F12) — the footgun: a message sent into a
 * still-working session is QUEUED by claude (accepted, runs after the current
 * turn), but a naive send reports it identically to a LOST message, so a consumer
 * that re-sends on "unconfirmed" double-runs. Run (after `npm run build`, with
 * authenticated claude under network isolation):
 *   CLAUDEMUX_SOCKET=cmux-busy node scripts/flows-send-while-busy.mjs
 *
 * Proves: a send into a working session returns DELIVERED_QUEUED (NOT
 * DELIVERY_UNCONFIRMED and NOT a fabricated cursor), and the queued turn actually
 * runs afterward — so the consumer knows "accepted, don't re-send."
 *
 * Isolated socket; throwaway cwd; the session self-killed.
 */
import { mkdirSync } from "node:fs";
import { DELIVERED_QUEUED, DELIVERY_UNCONFIRMED, create } from "../dist/index.js";

const CWD = "/tmp/cmux-busy-flows";
mkdirSync(CWD, { recursive: true });
const NS = "cmux-busy";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const txt = (msgs) => msgs.flatMap((m) => m.parts.map((p) => p.text ?? "")).join(" ");

async function main() {
  const s = await create({
    name: `busy-${Date.now().toString(36)}`,
    namespace: NS,
    cwd: CWD,
    trustWorkspace: true,
    bootTimeoutMs: 60_000,
  });
  try {
    // Turn 1: a long streaming turn that keeps the session WORKING.
    const c1 = await s.send(
      "Write a detailed 800-word essay about the history of the Unix operating system. Output the full essay directly, no preamble.",
    );
    await sleep(5000);
    rec("turn 1 keeps the session working", (await s.state()) === "working");

    // Turn 2: sent WHILE turn 1 is working → claude queues it.
    const c2 = await s.send("Reply with exactly the single word: TWO");
    rec(
      "send-while-busy returns DELIVERED_QUEUED (not UNCONFIRMED, not a cursor)",
      c2 === DELIVERED_QUEUED,
      c2 === DELIVERY_UNCONFIRMED ? "got UNCONFIRMED" : c2,
    );

    // Drain: turn 1 finishes, then the queued turn 2 runs.
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      if ((await s.state()) === "idle") break;
    }
    await sleep(2000);
    // The queued turn actually executed — proves DELIVERED_QUEUED meant "accepted".
    rec(
      "the queued turn actually ran afterward (not lost)",
      txt(await s.messagesSince(c1)).includes("TWO"),
    );
  } finally {
    await s.kill();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nSEND-WHILE-BUSY FLOWS: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
