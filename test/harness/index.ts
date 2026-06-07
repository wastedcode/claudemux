import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type SandboxHome, disposeSandboxHome, mintSandboxHome } from "./sandbox.js";
import { type Sentinel, plantSentinel, verifySentinel } from "./sentinel.js";
import { mintSocket, tmuxArgs } from "./socket.js";

/**
 * The five guards every integration test runs under:
 *
 *  1. **Private tmux socket** — `-L <unique> -f /dev/null` on every invocation
 *     (the actual "never reads `~/.tmux.conf`" guarantee).
 *  2. **Sandbox HOME + four XDG dirs** — under `/tmp` via `mktemp`.
 *  3. **Curated env** — spawned children get an explicit env object, not
 *     `process.env`-derived; this is the Node equivalent of `env -i`.
 *  4. **Sentinel mtime assertion** — a sentinel file in the real `~/.claude/`
 *     whose mtime must not move across the test.
 *  5. **Subprocess cleanup by PGID** — children spawned with `detached: true`
 *     (Node's `setsid` equivalent on POSIX); teardown SIGKILLs each captured
 *     PGID. Name-based matching (`pkill claude`, etc.) is banned tree-wide.
 */

/** Directory of `cmd` as found on the *ambient* PATH, or null if not found. */
function binDirOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return dir;
  }
  return null;
}

// The curated PATH must include the dirs of the tools the curated-env children
// actually exec, since it does NOT inherit the rest of `process.env`:
//   - the running node, so the CLI bin's `#!/usr/bin/env node` shebang resolves
//     wherever node lives (e.g. the Actions hosted toolcache, not /usr/bin);
//   - the tmux the matrix built from source (added to $GITHUB_PATH, ambient
//     only). Hardcoding /usr/bin masks this on Linux — which ships a preinstalled
//     tmux — but breaks macOS, where the only tmux is the from-source one outside
//     /usr/bin, so a CLI subprocess can't find it and exits non-zero. Resolving
//     it also makes Linux exercise the matrix version, not the preinstalled one.
const NODE_BIN_DIR = dirname(process.execPath);
const TMUX_BIN_DIR = binDirOnPath("tmux");
const CURATED_PATH = [NODE_BIN_DIR, TMUX_BIN_DIR, "/usr/local/bin", "/usr/bin", "/bin"]
  .filter((d): d is string => d !== null)
  .filter((d, i, a) => a.indexOf(d) === i)
  .join(":");

/**
 * Directory holding the real `claude` binary, resolved from the *ambient* PATH
 * — the one sanctioned exception to the curated-env rule. Only the **gated**
 * pre-auth boot tests (`CLAUDEMUX_LIVE_BOOT=1`) use this to reach an
 * installed-but-unauthenticated claude; the default `npm test`/CI run never
 * boots claude (it's hermetic — real tmux only), so this is dead weight there
 * and live only on demand. Resolve it — never hardcode a home: on a dev box
 * claude is on PATH at $HOME/.local/bin, and the literal home differs across
 * machines (/home/runner, /Users/...). Hardcoding one box's path is the exact
 * PATH-mismatch ADR 0005 flagged.
 */
export function claudeBinDir(): string {
  // Canonical install location (claude.ai/install.sh → $HOME/.local/bin).
  return binDirOnPath("claude") ?? join(process.env.HOME ?? "", ".local", "bin");
}

/** One curated env, built fresh per harness — never derived from `process.env`. */
function buildEnv(sandbox: SandboxHome, socket: string): Record<string, string> {
  return {
    HOME: sandbox.home,
    XDG_CONFIG_HOME: sandbox.xdgConfig,
    XDG_CACHE_HOME: sandbox.xdgCache,
    XDG_DATA_HOME: sandbox.xdgData,
    XDG_STATE_HOME: sandbox.xdgState,
    // The substrate selects its private socket from CLAUDEMUX_SOCKET (see
    // default-backend.ts); a bare TMUX_SOCKET is read by nobody (tmux uses -L,
    // not an env var), so CLI subprocesses would silently fall to the DEFAULT
    // socket and see sessions from any other consumer on the box.
    CLAUDEMUX_SOCKET: socket,
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    PATH: CURATED_PATH,
  };
}

export interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

export class Harness {
  readonly sandbox: SandboxHome;
  readonly socket: string;
  readonly env: Record<string, string>;
  readonly #sentinel: Sentinel;
  readonly #pgids = new Set<number>();
  #closed = false;

  private constructor(sandbox: SandboxHome, socket: string, sentinel: Sentinel) {
    this.sandbox = sandbox;
    this.socket = socket;
    this.env = buildEnv(sandbox, socket);
    this.#sentinel = sentinel;
  }

  /** Bootstrap a harness instance: sandbox HOME, unique socket, sentinel snapshot. */
  static create(): Harness {
    return new Harness(mintSandboxHome(), mintSocket(), plantSentinel());
  }

  /** Build a tmux argv prefix with the harness's private socket + `-f /dev/null`. */
  tmux(...rest: string[]): string[] {
    return tmuxArgs(this.socket, ...rest);
  }

  /**
   * Spawn a child with the curated env. The child runs `setsid`-detached so
   * its PGID equals its PID; we record the PGID for teardown SIGKILL sweep.
   *
   * Returns when the child exits. Stdout/stderr captured to strings.
   */
  async run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; input?: string } = {},
  ): Promise<RunResult> {
    const spawnOpts: SpawnOptions = {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    };
    const child = spawn(cmd, args, spawnOpts);
    if (child.pid !== undefined) this.#pgids.add(child.pid);
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    const exit = await new Promise<number>((res) => {
      child.on("close", (code) => res(code ?? -1));
      child.on("error", () => res(-1));
    });
    if (child.pid !== undefined) this.#pgids.delete(child.pid);
    return { exit, stdout, stderr };
  }

  /** Convenience: run a tmux command with the harness's socket + `-f /dev/null`. */
  runTmux(...args: string[]): Promise<RunResult> {
    return this.run("tmux", this.tmux(...args));
  }

  /**
   * Tear down: kill tracked PGIDs, kill the tmux server, dispose the
   * sandbox HOME, verify the sentinel mtime. Idempotent.
   *
   * Returns a leak description if the sentinel moved, else `null`.
   */
  async teardown(): Promise<string | null> {
    if (this.#closed) return null;
    this.#closed = true;

    // Step 1: kill-session for any sessions still around (named, ours by construction).
    // We don't enumerate — the next step (kill-server) handles cleanup.
    try {
      await this.runTmux("kill-server");
    } catch {
      // ignore — server may already be down
    }

    // Step 2: SIGKILL any PGIDs we captured but haven't cleaned up.
    for (const pgid of this.#pgids) {
      try {
        // Negative PID = process group. SIGKILL = 9.
        process.kill(-pgid, "SIGKILL");
      } catch {
        // ignore — already gone is fine
      }
    }
    this.#pgids.clear();

    disposeSandboxHome(this.sandbox);
    return verifySentinel(this.#sentinel);
  }
}
