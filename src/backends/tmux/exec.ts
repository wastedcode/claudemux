import { spawn } from "node:child_process";
import { BackendError, SessionGone, TmuxUnreachable } from "../../errors.js";
import { Emitter } from "../../util/emitter.js";
import type { BackendEvent } from "../types.js";

/**
 * Raw result of one tmux invocation. Callers (sessions.ts, keys.ts,
 * capture.ts) interpret this — typed errors are thrown at the caller, not
 * here, because only the caller knows the session-name context for the error.
 */
export interface TmuxResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * One executor instance per backend. Holds the private socket name and the
 * observability emitter. Every tmux invocation goes through {@link run}; that
 * is what enforces the `-f /dev/null` + `-L <socket>` discipline tree-wide.
 *
 * See `engineer/wiki/tmux-private-server-bootstrap` — bare `-L` does not
 * prevent `~/.tmux.conf` reads; both flags are required.
 */
export class TmuxExec {
  readonly socket: string;
  readonly #events = new Emitter<BackendEvent>();

  constructor(socket: string) {
    this.socket = socket;
  }

  /** Subscribe to every tmux invocation + result. Returns unsubscribe. */
  onCommand(handler: (e: BackendEvent) => void): () => void {
    return this.#events.on(handler);
  }

  /**
   * Spawn `tmux -L <socket> -f /dev/null <args...>` and capture both streams.
   *
   * Reading both stdout and stderr is required — the `Pane is dead` annotation
   * lands on stdout (Case A), while `can't find …` lands on stderr (Case B).
   * A wrapper that reads only one stream misses one case (see
   * `engineer/wiki/tmux-pane-death-detection`).
   *
   * @throws `TmuxUnreachable` on spawn failure (ENOENT, EPIPE, "no server
   *   running" on a connect-only operation, etc.). The session-name field
   *   on the typed error is the *requested* session (passed by the caller).
   */
  async run(
    args: string[],
    opts: { sessionName?: string; input?: string } = {},
  ): Promise<TmuxResult> {
    const fullArgs = ["-L", this.socket, "-f", "/dev/null", ...args];
    const sessionName = opts.sessionName ?? "<unknown>";
    const startedAt = Date.now();
    return new Promise<TmuxResult>((resolve, reject) => {
      const child = spawn("tmux", fullArgs, {
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: process.env as Record<string, string>,
      });
      if (opts.input !== undefined && child.stdin) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }
      let stdout = "";
      let stderr = "";
      let spawnErr: Error | null = null;
      child.stdout?.on("data", (b) => {
        stdout += b.toString("utf8");
      });
      child.stderr?.on("data", (b) => {
        stderr += b.toString("utf8");
      });
      child.on("error", (err) => {
        spawnErr = err;
      });
      child.on("close", (code) => {
        const durationMs = Date.now() - startedAt;
        const exit = code ?? -1;
        this.#events.emit({
          ts: startedAt,
          argv: ["tmux", ...fullArgs],
          durationMs,
          exit,
          stdout,
          stderr,
        });
        if (spawnErr) {
          reject(new TmuxUnreachable(sessionName, spawnErr));
          return;
        }
        // "no server running" — tmux is on PATH but its server is down on
        // a connect-only operation. Promote to TmuxUnreachable.
        if (exit !== 0 && /no server running on/i.test(stderr)) {
          reject(new TmuxUnreachable(sessionName, new Error(stderr.trim())));
          return;
        }
        resolve({ exit, stdout, stderr, durationMs });
      });
    });
  }
}

/** Lowercase substrings tmux emits on stderr for the "target gone" Case B. */
const SESSION_GONE_PATTERNS = ["can't find session:", "can't find pane:", "can't find window:"];

/**
 * Classify a non-zero `TmuxResult` into a typed error. Callers use this when
 * the operation was expected to succeed; for idempotent ops (kill), callers
 * inspect `result.exit` + stderr directly and choose to swallow SessionGone.
 *
 * Returns `null` if the result looks successful (exit 0 with no error
 * annotation on stdout), otherwise the right typed error to throw.
 *
 * `sessionName` is the requested target (so the error carries the right
 * context even when tmux's stderr names something else).
 */
export function classifyTmuxFailure(
  sessionName: string,
  argv: readonly string[],
  result: TmuxResult,
): Error | null {
  if (result.exit === 0) return null;
  const lcStderr = result.stderr.toLowerCase();
  if (SESSION_GONE_PATTERNS.some((p) => lcStderr.includes(p))) {
    return new SessionGone(sessionName);
  }
  return new BackendError(sessionName, argv, result.exit, result.stderr);
}

/**
 * Detect the "Pane is dead (signal N, …)" annotation in capture-pane output.
 * Returns the signal number on a match, else `null`.
 */
export function detectPaneDeadAnnotation(stdout: string): number | null {
  const m = stdout.match(/Pane is dead \(signal (\d+),/);
  if (!m) return null;
  const signal = Number(m[1]);
  return Number.isFinite(signal) ? signal : null;
}
