import { Command } from "commander";
import { ClaudemuxError } from "../errors.js";
import { captureCli } from "./capture.js";
import { existsCli } from "./exists.js";
import { killCli } from "./kill.js";
import { listCli } from "./list.js";
import { sendCli } from "./send.js";
import { spawnCli } from "./spawn.js";
import { stateCli } from "./state.js";
import { waitCli } from "./wait.js";

/**
 * Build the `claudemux` commander entry. Exported separately from `bin/`
 * so tests can drive it without spawning a subprocess.
 *
 * Verb names match the library 1:1 — `claudemux send name "..."` is
 * `send(name, "...")` on the library side. Help strings carry zero
 * references to any specific backend (the substrate is backend-neutral
 * by design; tmux is one implementation detail).
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name("claudemux").description("Drive long-lived Claude Code sessions from Node.");

  const ns = (cmd: Command) =>
    cmd
      .option("-n, --namespace <name>", 'session namespace (default: "claudemux")')
      .option("-a, --agent <name>", 'agent (default: "claude"; only "claude" supported in v0.0.1)');

  ns(program.command("spawn <name>"))
    .description("start a session and wait for the REPL to be ready")
    .requiredOption("--cwd <path>", "working directory for the session")
    .option("--boot-timeout-ms <ms>", "boot timeout (default 60000)", parseIntOpt)
    .action(
      async (
        name: string,
        opts: { cwd: string; namespace?: string; agent?: string; bootTimeoutMs?: number },
      ) => {
        await spawnCli(name, opts);
      },
    );

  ns(program.command("send <name> <text>"))
    .description("deliver text as one logical user turn (use '-' to read from stdin)")
    .action(async (name: string, text: string, opts: { namespace?: string; agent?: string }) => {
      await sendCli(name, text, opts);
    });

  ns(program.command("wait <name>"))
    .description("block until the session reaches idle/permission-prompt/dialog")
    .option("--timeout-ms <ms>", "timeout in ms (default 300000)", parseIntOpt)
    .action(
      async (name: string, opts: { namespace?: string; agent?: string; timeoutMs?: number }) => {
        await waitCli(name, opts);
      },
    );

  ns(program.command("state <name>"))
    .description("print the current pane state")
    .action(async (name: string, opts: { namespace?: string; agent?: string }) => {
      await stateCli(name, opts);
    });

  ns(program.command("capture <name>"))
    .description("print the pane text")
    .option("--ansi", "preserve escape sequences")
    .option("--lines <n>", "print only the bottom-N lines", parseIntOpt)
    .action(
      async (
        name: string,
        opts: { namespace?: string; agent?: string; ansi?: boolean; lines?: number },
      ) => {
        await captureCli(name, opts);
      },
    );

  program
    .command("kill <name>")
    .description("kill the named session (idempotent — kill of a missing session is success)")
    .option("-n, --namespace <name>", 'session namespace (default: "claudemux")')
    .action(async (name: string, opts: { namespace?: string }) => {
      await killCli(name, opts);
    });

  program
    .command("list [namespace]")
    .description("print short session names in the namespace, one per line")
    .action(async (namespace: string | undefined) => {
      await listCli(namespace === undefined ? {} : { namespace });
    });

  program
    .command("exists <name>")
    .description('print "true"/"false"; exit 0 if alive, 1 if not')
    .option("-n, --namespace <name>", 'session namespace (default: "claudemux")')
    .action(async (name: string, opts: { namespace?: string }) => {
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
