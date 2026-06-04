/**
 * Acceptance: drive a REAL claude session end-to-end through claudemux's public
 * API and prove the turn contract works — reliable "is it done?" from hooks +
 * the conversation read back from the transcript, with NO pane-scraping.
 *
 * Run (after `npm run build`):
 *   CLAUDEMUX_SOCKET=claudemux-accept node scripts/acceptance.mjs
 *
 * Requires: an authenticated `claude` on PATH. Uses a throwaway cwd and a
 * uniquely-named session it kills at the end — it never touches other sessions.
 * Set CLAUDEMUX_SOCKET to a private socket (as above) to fully isolate the run.
 */
import { mkdirSync } from "node:fs";
import { create } from "../dist/index.js";

const NAME = `accept-${Date.now().toString(36)}`;
const CWD = "/tmp/cmux-accept";
mkdirSync(CWD, { recursive: true });

const log = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
let session;
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  console.log("\n[1] create() — spawn + boot a real claude session\n");
  session = await create({ name: NAME, cwd: CWD, trustWorkspace: true, bootTimeoutMs: 60_000 });
  log("agentSessionId", session.agentSessionId);
  check("session booted, id surfaced", typeof session.agentSessionId === "string");

  console.log("\n[2] send() — deliver a turn, get a cursor\n");
  const cursor = await session.send("Reply with exactly the single word: PONG");
  log("cursor", cursor);
  check("send returned a cursor", typeof cursor === "string");

  console.log(`\n[3] progress() — wait for "done" via HOOKS (no pane-scraping)\n`);
  // Patience is the CONSUMER's (mechanism, not policy): we poll progress() and
  // give up after our own budget. claudemux only reports the signal.
  const deadline = Date.now() + 60_000;
  let p;
  const phasesSeen = [];
  while (Date.now() < deadline) {
    p = await session.progress();
    if (phasesSeen.at(-1) !== p.phase) {
      phasesSeen.push(p.phase);
      log(
        "phase",
        `${p.phase}  (hookChannelHealthy=${p.hookChannelHealthy}, toolInFlight=${p.toolInFlight})`,
      );
    }
    if (p.phase === "done") break;
    await new Promise((r) => setTimeout(r, 400));
  }
  log("phases seen", phasesSeen.join(" → "));
  check("reached phase=done", p?.phase === "done");
  check("done came from the hook channel (reliable)", p?.hookChannelHealthy === true);

  console.log(`\n[4] messagesSince(cursor) — read the turn's conversation\n`);
  const msgs = await session.messagesSince(cursor);
  for (const m of msgs) {
    const text = m.parts
      .map((x) => (x.kind === "text" ? x.text : `[${x.kind}:${x.tool ?? ""}]`))
      .join("");
    log(m.role, text);
  }
  const reply = msgs.find((m) => m.role === "assistant");
  check("assistant reply present", Boolean(reply));
  check(
    "reply is PONG",
    reply?.parts.some((x) => x.kind === "text" && x.text.includes("PONG")) ?? false,
  );

  console.log("\n[5] state() + capture() — the other reads\n");
  log("state()", await session.state());
  log(
    "capture() tail",
    (await session.capture({ lines: 3 })).split("\n").filter(Boolean).at(-1) ?? "",
  );
} finally {
  if (session) {
    await session.kill();
    console.log("\n[6] kill() — session torn down\n");
  }
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${"=".repeat(48)}`);
console.log(`ACCEPTANCE: ${passed}/${checks.length} checks passed`);
console.log(`${"=".repeat(48)}\n`);
process.exit(passed === checks.length ? 0 : 1);
