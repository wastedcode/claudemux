/**
 * Permission-prompt acceptance (F33 / F49) — the full S5 flow against a live
 * claude in DEFAULT permission mode, the exact case an unattended Posse session
 * faces. Run (after `npm run build`, with authenticated claude under network
 * isolation):
 *   CLAUDEMUX_SOCKET=cmux-prompt node scripts/flows-permission-prompt.mjs
 *
 * Proves both branches end-to-end:
 *   send (tool-triggering) → wait()→awaiting{permission-prompt} → state()→
 *   permission-prompt → respond(choice) → wait()→completed.
 *   - approve: the tool RUNS (file written), messagesSince surfaces the turn.
 *   - deny:    the tool is REFUSED (no file), and wait() still resolves to a
 *              terminal outcome — NOT a budget timeout (the denied tool leaves a
 *              dangling tool-start that a settled idle pane must override).
 *
 * Isolated socket; throwaway cwd; every session self-killed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { create } from "../dist/index.js";

const CWD = "/tmp/cmux-prompt-flows";
mkdirSync(CWD, { recursive: true });
const NS = "cmux-prompt";

const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const opts = (name) => ({
  name,
  namespace: NS,
  cwd: CWD,
  trustWorkspace: true,
  bootTimeoutMs: 60_000,
  // Force DEFAULT permission mode for THIS session, regardless of the box's
  // global settings.json. Without this the suite is non-hermetic: a daemon/CI
  // host configured `permissions.defaultMode: "bypassPermissions"` (the common
  // unattended setup) never prompts, so every `awaiting{permission-prompt}`
  // assertion fails — not because the substrate is wrong (it correctly reports
  // `completed`, the tool having run un-gated) but because there is no gate to
  // observe. `--permission-mode` (a CLI flag) overrides the ambient default.
  extraArgs: ["--permission-mode", "default"],
});

async function approvePath() {
  const s = await create(opts(`approve-${Date.now().toString(36)}`));
  try {
    const file = "approved.txt";
    rmSync(join(CWD, file), { force: true });
    const cursor = await s.send(
      `Create a file named ${file} containing exactly the word PONG. Use the Write tool. Do not ask me anything first.`,
    );
    const out1 = await s.wait({ timeoutMs: 60_000 });
    rec(
      "approve: wait() → awaiting{permission-prompt}",
      out1.kind === "awaiting" && out1.on === "permission-prompt",
      JSON.stringify(out1),
    );
    rec("approve: state() reads 'permission-prompt'", (await s.state()) === "permission-prompt");
    await s.respond("approve");
    const out2 = await s.wait({ timeoutMs: 60_000 });
    rec(
      "approve: after respond, wait() → completed",
      out2.kind === "completed",
      JSON.stringify(out2),
    );
    rec(
      "approve: the tool RAN (file written with PONG)",
      existsSync(join(CWD, file)) && readFileSync(join(CWD, file), "utf8").includes("PONG"),
    );
    rec(
      "approve: messagesSince(cursor) returns the turn",
      (await s.messagesSince(cursor)).length > 0,
    );
  } finally {
    await s.kill();
  }
}

async function denyPath() {
  const s = await create(opts(`deny-${Date.now().toString(36)}`));
  try {
    const file = "denied.txt";
    rmSync(join(CWD, file), { force: true });
    await s.send(
      `Create a file named ${file} containing the word NOPE. Use the Write tool. Do not ask me anything first.`,
    );
    const out1 = await s.wait({ timeoutMs: 60_000 });
    rec(
      "deny: wait() → awaiting{permission-prompt}",
      out1.kind === "awaiting" && out1.on === "permission-prompt",
      JSON.stringify(out1),
    );
    await s.respond("deny");
    const out2 = await s.wait({ timeoutMs: 60_000 });
    // The denied tool fires tool-start but never tool-end; without the idle-pane
    // override the hook belief stays 'working' and wait() budget-times-out. The
    // honest outcome is a terminal one (the turn is over), NOT budget-exceeded.
    rec(
      "deny: after respond, wait() resolves terminal (NOT budget-exceeded)",
      out2.kind !== "budget-exceeded",
      JSON.stringify(out2),
    );
    rec("deny: the tool was REFUSED (no file)", !existsSync(join(CWD, file)));
  } finally {
    await s.kill();
  }
}

async function main() {
  await approvePath();
  await denyPath();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nPERMISSION-PROMPT FLOWS: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
