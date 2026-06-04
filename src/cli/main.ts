import { Command } from "commander";
import { ClaudemuxError } from "../errors.js";
import { type AskCliOpts, askCli } from "./ask.js";
import { type CaptureCliOpts, captureCli } from "./capture.js";
import type { CommonOpts, RefOpts } from "./context.js";
import { existsCli } from "./exists.js";
import { interruptCli } from "./interrupt.js";
import { killCli } from "./kill.js";
import { listCli } from "./list.js";
import { messagesCli } from "./messages.js";
import { respondCli } from "./respond.js";
import { type ResumeCliOpts, resumeCli } from "./resume.js";
import { sendCli } from "./send.js";
import { type SpawnCliOpts, spawnCli } from "./spawn.js";
import { stateCli } from "./state.js";
import { turnCompleteCli } from "./turn-complete.js";
import { type WaitCliOpts, waitCli } from "./wait.js";

/**
 * Build the `claudemux` commander entry. Exported separately from `bin/`
 * so tests can drive it without spawning a subprocess.
 *
 * Verb names match the library 1:1 — `claudemux send name "..."` is
 * `send(name, "...")` on the library side. Help strings carry zero
 * references to any specific backend.
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name("claudemux").description("Drive long-lived Claude Code sessions from Node.");

  // Every verb locates a session: namespace prefix + an explicit socket override
  // (the latter for dev / debugging — most users share the default socket).
  const common = (cmd: Command) =>
    cmd
      .option("-n, --namespace <name>", 'session namespace (default: "claudemux")')
      .option(
        "-s, --socket <name>",
        'explicit socket name (default: $CLAUDEMUX_SOCKET or "claudemux")',
      );

  // Verbs that resolve an AGENT (spawn/resume/send/ask/…) also take --agent.
  // Registry verbs (kill/list/exists) don't — they query the backend by name,
  // so --agent there would be dead. Keeping it off them is the coherent shape.
  const withAgent = (cmd: Command) =>
    common(cmd).option(
      "-a, --agent <name>",
      'agent (default: "claude"; only "claude" supported in v0.0.1)',
    );

  withAgent(program.command("spawn <name>"))
    .description("start a session and wait for the REPL to be ready")
    .requiredOption("--cwd <path>", "working directory for the session")
    .option("--boot-timeout-ms <ms>", "boot timeout (default 60000)", parseIntOpt)
    .option(
      "--trust-workspace",
      "grant the agent read/edit/execute on --cwd (writes a persistent per-folder trust flag); without it, an untrusted folder fails closed",
    )
    .action(async (name: string, opts: SpawnCliOpts) => {
      await spawnCli(name, opts);
    });

  withAgent(program.command("resume <name> <agentSessionId>"))
    .description("continue an existing conversation in a fresh pane")
    .requiredOption("--cwd <path>", "working directory for the session")
    .option("--boot-timeout-ms <ms>", "boot timeout (default 60000)", parseIntOpt)
    .option("--trust-workspace", "grant the agent read/edit/execute on --cwd (see spawn)")
    .action(async (name: string, agentSessionId: string, opts: ResumeCliOpts) => {
      await resumeCli(name, agentSessionId, opts);
    });

  withAgent(program.command("send <name> <text>"))
    .description("deliver text as one logical user turn (use '-' to read from stdin)")
    .action(async (name: string, text: string, opts: CommonOpts) => {
      await sendCli(name, text, opts);
    });

  withAgent(program.command("ask <name> <text>"))
    .description("one Q&A round-trip: send, wait for the turn, print outcome + messages")
    .option("--timeout-ms <ms>", "wall-clock cap in ms (CLI default 300000)", parseIntOpt)
    .option("--idle-ms <ms>", "give up after this long with no progress", parseIntOpt)
    .action(async (name: string, text: string, opts: AskCliOpts) => {
      await askCli(name, text, opts);
    });

  withAgent(program.command("messages <name> <cursor>"))
    .description("print the messages produced since <cursor> (from send/ask) as JSON")
    .action(async (name: string, cursor: string, opts: CommonOpts) => {
      await messagesCli(name, cursor, opts);
    });

  withAgent(program.command("turn-complete <name> <cursor>"))
    .description("print true/false (exit 0/1): did the turn at <cursor> produce a reply?")
    .action(async (name: string, cursor: string, opts: CommonOpts) => {
      await turnCompleteCli(name, cursor, opts);
    });

  withAgent(program.command("interrupt <name>"))
    .description("fire ESC at the session to stop a working agent (harmless when idle)")
    .action(async (name: string, opts: CommonOpts) => {
      await interruptCli(name, opts);
    });

  withAgent(program.command("respond <name> <choice>"))
    .description("answer a permission prompt: choice = approve | approve-for-session | deny")
    .action(async (name: string, choice: string, opts: CommonOpts) => {
      await respondCli(name, choice, opts);
    });

  withAgent(program.command("wait <name>"))
    .description("block until the turn reaches a terminal outcome; print it as JSON")
    .option("--timeout-ms <ms>", "wall-clock cap in ms (CLI default 300000)", parseIntOpt)
    .option("--idle-ms <ms>", "give up after this long with no progress", parseIntOpt)
    .action(async (name: string, opts: WaitCliOpts) => {
      await waitCli(name, opts);
    });

  withAgent(program.command("state <name>"))
    .description("print the current fused session state")
    .action(async (name: string, opts: CommonOpts) => {
      await stateCli(name, opts);
    });

  withAgent(program.command("capture <name>"))
    .description("print the pane text")
    .option("--ansi", "preserve escape sequences")
    .option("--lines <n>", "print only the bottom-N lines", parseIntOpt)
    .action(async (name: string, opts: CaptureCliOpts) => {
      await captureCli(name, opts);
    });

  common(program.command("kill <name>"))
    .description("kill the named session (idempotent — kill of a missing session is success)")
    .action(async (name: string, opts: RefOpts) => {
      await killCli(name, opts);
    });

  common(program.command("list [namespace]"))
    .description("print short session names in the namespace, one per line")
    .action(async (positionalNs: string | undefined, opts: RefOpts) => {
      await listCli(positionalNs, opts);
    });

  common(program.command("exists <name>"))
    .description('print "true"/"false"; exit 0 if alive, 1 if not')
    .action(async (name: string, opts: RefOpts) => {
      await existsCli(name, opts);
    });

  return program;
}

function parseIntOpt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`invalid integer: ${raw}`);
  return n;
}

/** Entry point — handles typed-error exit codes uniformly. */
export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof ClaudemuxError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`claudemux: ${(err as Error).message}\n`);
    return 1;
  }
}
