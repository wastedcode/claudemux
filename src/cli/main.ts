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
 * references to any specific backend.
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name("claudemux").description("Drive long-lived Claude Code sessions from Node.");

  // Every verb accepts these three: namespace prefix, agent kind, and an
  // explicit socket override (the latter for dev / debugging — most users
  // share the default socket).
  const common = (cmd: Command) =>
    cmd
      .option("-n, --namespace <name>", 'session namespace (default: "claudemux")')
      .option("-a, --agent <name>", 'agent (default: "claude"; only "claude" supported in v0.0.1)')
      .option(
        "-s, --socket <name>",
        'explicit socket name (default: $CLAUDEMUX_SOCKET or "claudemux")',
      );

  common(program.command("spawn <name>"))
    .description("start a session and wait for the REPL to be ready")
    .requiredOption("--cwd <path>", "working directory for the session")
    .option("--boot-timeout-ms <ms>", "boot timeout (default 60000)", parseIntOpt)
    .action(
      async (
        name: string,
        opts: {
          cwd: string;
          namespace?: string;
          agent?: string;
          socket?: string;
          bootTimeoutMs?: number;
        },
      ) => {
        await spawnCli(name, opts);
      },
    );

  common(program.command("send <name> <text>"))
    .description("deliver text as one logical user turn (use '-' to read from stdin)")
    .action(
      async (
        name: string,
        text: string,
        opts: { namespace?: string; agent?: string; socket?: string },
      ) => {
        await sendCli(name, text, opts);
      },
    );

  common(program.command("wait <name>"))
    .description("block until the session reaches idle/permission-prompt/dialog")
    .option("--timeout-ms <ms>", "timeout in ms (default 300000)", parseIntOpt)
    .action(
      async (
        name: string,
        opts: { namespace?: string; agent?: string; socket?: string; timeoutMs?: number },
      ) => {
        await waitCli(name, opts);
      },
    );

  common(program.command("state <name>"))
    .description("print the current pane state")
    .action(async (name: string, opts: { namespace?: string; agent?: string; socket?: string }) => {
      await stateCli(name, opts);
    });

  common(program.command("capture <name>"))
    .description("print the pane text")
    .option("--ansi", "preserve escape sequences")
    .option("--lines <n>", "print only the bottom-N lines", parseIntOpt)
    .action(
      async (
        name: string,
        opts: {
          namespace?: string;
          agent?: string;
          socket?: string;
          ansi?: boolean;
          lines?: number;
        },
      ) => {
        await captureCli(name, opts);
      },
    );

  common(program.command("kill <name>"))
    .description("kill the named session (idempotent — kill of a missing session is success)")
    .action(async (name: string, opts: { namespace?: string; socket?: string }) => {
      await killCli(name, opts);
    });

  common(program.command("list [namespace]"))
    .description("print short session names in the namespace, one per line")
    .action(
      async (positionalNs: string | undefined, opts: { namespace?: string; socket?: string }) => {
        // Accept both the positional and the --namespace flag; flag wins
        // if both are present (the CLI vocabulary across verbs uses --namespace).
        const ns = opts.namespace ?? positionalNs;
        await listCli({
          ...(ns === undefined ? {} : { namespace: ns }),
          ...(opts.socket === undefined ? {} : { socket: opts.socket }),
        });
      },
    );

  common(program.command("exists <name>"))
    .description('print "true"/"false"; exit 0 if alive, 1 if not')
    .action(async (name: string, opts: { namespace?: string; socket?: string }) => {
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
