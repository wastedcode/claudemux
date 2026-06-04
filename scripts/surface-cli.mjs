/**
 * CLI SURFACE acceptance — drives the REAL `bin/claudemux` binary through every
 * command end-to-end against a live claude. Run (after `npm run build`):
 *   CLAUDEMUX_SOCKET=cmux-cli node scripts/surface-cli.mjs
 *
 * Covers: spawn · exists · list · send · wait · messages · ask · state ·
 * capture · interrupt · resume · respond (permission-prompt) · kill. Isolated
 * socket; every session killed.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const BIN = new URL("../bin/claudemux", import.meta.url).pathname;
const CWD = "/tmp/cmux-cli-surface";
mkdirSync(CWD, { recursive: true });
const NS = "cmux-cli";
const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${String(detail).slice(0, 60)}` : ""}`);
};

/** Run the CLI; resolve { code, stdout, stderr } (never reject on non-zero). */
async function cli(...args) {
  try {
    const { stdout, stderr } = await pexec(BIN, [...args, "-n", NS], { timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
  }
}

async function main() {
  const a = `cli-a-${Date.now().toString(36)}`;

  const sp = await cli("spawn", a, "--cwd", CWD, "--trust-workspace");
  const spawnId = JSON.parse(sp.stdout || "{}").agentSessionId;
  rec(
    "spawn prints the agentSessionId",
    typeof spawnId === "string" && spawnId.length > 0,
    spawnId,
  );

  rec("exists → true (exit 0)", (await cli("exists", a)).stdout.trim() === "true");
  rec("list includes the session", (await cli("list")).stdout.split("\n").includes(a));

  const send = await cli("send", a, "Reply with exactly the single word: PONG");
  const cursor = JSON.parse(send.stdout || "{}").cursor;
  rec("send prints a cursor", typeof cursor === "string" && cursor.length > 0, cursor);

  const w = await cli("wait", a);
  rec(
    "wait prints a completed TurnOutcome (exit 0)",
    w.code === 0 && JSON.parse(w.stdout).kind === "completed",
    w.stdout.trim(),
  );

  const msgs = await cli("messages", a, cursor);
  rec(
    "messages prints the reply for the cursor",
    JSON.stringify(JSON.parse(msgs.stdout)).includes("PONG"),
    msgs.stdout.trim(),
  );

  const ask = await cli("ask", a, "Reply with exactly: OK");
  const askOut = JSON.parse(ask.stdout || "{}");
  rec(
    "ask prints { outcome, messages, cursor } and exits 0 on completed",
    ask.code === 0 && askOut.outcome?.kind === "completed",
    JSON.stringify(askOut.outcome),
  );

  rec(
    "state prints a verdict",
    (await cli("state", a)).stdout.trim().length > 0,
    (await cli("state", a)).stdout.trim(),
  );
  rec("capture prints pane text", (await cli("capture", a)).stdout.length > 0);

  // interrupt: kick off a long turn (fire-and-forget), then interrupt it.
  cli("send", a, "Write a long 400-word essay about Unix history. Output it directly.").catch(
    () => {},
  );
  await new Promise((r) => setTimeout(r, 4000));
  const intr = await cli("interrupt", a);
  rec("interrupt exits cleanly", intr.code === 0);
  await new Promise((r) => setTimeout(r, 1500));

  // resume: kill the pane, continue the conversation in a fresh one via the id.
  await cli("kill", a);
  await new Promise((r) => setTimeout(r, 500));
  const b = `cli-b-${Date.now().toString(36)}`;
  const rs = await cli("resume", b, spawnId, "--cwd", CWD, "--trust-workspace");
  rec(
    "resume prints the resumed id (exit 0)",
    rs.code === 0 && JSON.parse(rs.stdout || "{}").agentSessionId === spawnId,
    rs.stdout.trim() || rs.stderr.trim(),
  );

  await cli("kill", b);
  rec("kill → exists false (exit 1)", (await cli("exists", b)).code === 1);

  // respond: a default-mode session that hits a tool-approval prompt — the
  // stateless CLI surfaces it via `wait` and answers it via `respond`.
  const p = `cli-p-${Date.now().toString(36)}`;
  await cli("spawn", p, "--cwd", CWD, "--trust-workspace");
  rec(
    "respond rejects an unknown choice (exit != 0)",
    (await cli("respond", p, "bogus-choice")).code !== 0,
  );
  await cli(
    "send",
    p,
    "Create a file named cli-approved.txt with the word PONG. Use the Write tool. Do not ask first.",
  );
  const pw1 = await cli("wait", p);
  rec(
    "wait prints awaiting{permission-prompt}",
    pw1.stdout.includes("permission-prompt"),
    pw1.stdout.trim(),
  );
  rec("respond approve exits cleanly", (await cli("respond", p, "approve")).code === 0);
  const pw2 = await cli("wait", p);
  rec("after respond, wait prints completed", pw2.stdout.includes("completed"), pw2.stdout.trim());
  await cli("kill", p);
}

try {
  await main();
} catch (e) {
  rec("cli surface threw", false, String(e?.stack ?? e));
} finally {
  for (const n of (await cli("list")).stdout.split("\n").filter(Boolean)) {
    await cli("kill", n).catch(() => {});
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`CLI SURFACE: ${pass}/${results.length} checks passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
console.log(`${"=".repeat(56)}\n`);
process.exit(pass === results.length ? 0 : 1);
