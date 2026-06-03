import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { BackendError, BackendUnreachable, SessionExists, SessionGone } from "../../errors.js";
import { Emitter } from "../../util/emitter.js";
import type { BackendEvent } from "../types.js";

/**
 * tmux stderr patterns that indicate "the backend's server is not reachable
 * on this socket." Older tmux says `no server running on /tmp/.../sock`;
 * tmux ≥3.3 says `error connecting to /tmp/.../sock (No such file or
 * directory)`. We treat both as the same condition (server's gone).
 *
 * Single-source — callers (`sessions.ts`, `classifyTmuxFailure`) import
 * from here so the regex can't drift.
 */
export function isNoServerStderr(text: string): boolean {
  return /no server running on/i.test(text) || /error connecting to /i.test(text);
}

/**
 * tmux stderr substrings that indicate "the target you asked about doesn't
 * exist on this server." tmux emits different `can't find …:` strings
 * depending on which level of the `session:window.pane` grammar failed.
 * All three are semantically "the session you wanted isn't here" — callers
 * that need a boolean (`hasSession`) treat them all as "no" rather than
 * letting the routine `can't find pane:`/`can't find window:` shapes
 * escape as `SessionGone` throws.
 */
const SESSION_GONE_PATTERNS = ["can't find session:", "can't find pane:", "can't find window:"];

export function isSessionGoneStderr(text: string): boolean {
  const lower = text.toLowerCase();
  return SESSION_GONE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * tmux stderr shape when `new-session -s <name>` races another process
 * creating the same target. With the shared default socket (ADR 0006),
 * concurrent `spawn`s of the same name are routine, and the TOCTOU window
 * between `create()`'s exists-check and `backend.spawn()` means tmux —
 * not the substrate's check — sometimes discovers the collision. The
 * semantically-correct typed error is `SessionExists`, same as a check-time
 * collision: the substrate refuses to silently adopt either way.
 */
export function isDuplicateSessionStderr(text: string): boolean {
  return /duplicate session:/i.test(text);
}

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
 * Default per-invocation timeout. tmux read/control ops (capture-pane,
 * has-session, new-session, …) return in milliseconds against a healthy
 * server; 10s is generous headroom. The long-lived "wait for the agent"
 * budget belongs to `io/wait.ts`'s loop, NOT to a single subprocess — so
 * a wedged tmux (process alive but unresponsive: NFS stall, server bug,
 * modal pane) surfaces as a typed `BackendUnreachable[timeout]` inside
 * `wait()`'s budget rather than hanging the consumer's `await` forever.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

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
   * @throws `BackendUnreachable` — `spawn-failed` on spawn error (ENOENT,
   *   EPIPE), `no-server` when the server isn't running on a connect-only
   *   operation, `timeout` when the invocation doesn't return within
   *   `opts.timeoutMs` (default {@link DEFAULT_EXEC_TIMEOUT_MS}). The
   *   session-name field on the typed error is the *requested* session.
   */
  async run(
    args: string[],
    opts: { sessionName?: string; input?: string; timeoutMs?: number } = {},
  ): Promise<TmuxResult> {
    const fullArgs = ["-L", this.socket, "-f", "/dev/null", ...args];
    const sessionName = opts.sessionName ?? "<unknown>";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
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
      let settled = false;

      // Per-invocation timeout: SIGKILL the child WE spawned (peer-process-safe
      // by construction — exact PID, ADR 0004) and reject. The `close` handler
      // still fires after the kill, but `settled` guards against double-settle.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(
          new BackendUnreachable(
            sessionName,
            "timeout",
            new Error(`backend command did not return within ${timeoutMs}ms`),
          ),
        );
      }, timeoutMs);
      timer.unref?.();

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
        if (settled) return; // already rejected via timeout
        settled = true;
        clearTimeout(timer);
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
          reject(new BackendUnreachable(sessionName, "spawn-failed", spawnErr));
          return;
        }
        // tmux is on PATH but its server is down on a connect-only
        // operation. Both shapes ("no server running on …" and
        // "error connecting to …") are the same condition — promote.
        // Don't echo the raw stderr (it leaks "tmux" via the socket path).
        if (exit !== 0 && isNoServerStderr(stderr)) {
          reject(
            new BackendUnreachable(
              sessionName,
              "no-server",
              new Error("no server running on the configured socket"),
            ),
          );
          return;
        }
        resolve({ exit, stdout, stderr, durationMs });
      });
    });
  }
}

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
 *
 * Order matters: `BackendUnreachable` (no server) > `SessionExists`
 * (duplicate-session race) > `SessionGone` (target doesn't exist) >
 * `BackendError` (unrecognized failure). The routine failure modes are
 * promoted above `BackendError` so the substrate surfaces a clean typed
 * error rather than the catch-all. As a structural backstop,
 * `BackendError.message` itself does not embed the tmux argv (see
 * `errors.ts`), so even an unclassified shape cannot leak the backend's
 * vocabulary into user-facing text.
 */
export function classifyTmuxFailure(
  sessionName: string,
  argv: readonly string[],
  result: TmuxResult,
): Error | null {
  if (result.exit === 0) return null;
  if (isNoServerStderr(result.stderr)) {
    // Don't echo the backend's stderr (path + "tmux" substring leak).
    // The clean public summary tells the user what they can do; the raw
    // stderr is still available via observability (`onBackendCommand`).
    return new BackendUnreachable(
      sessionName,
      "no-server",
      new Error("no server running on the configured socket"),
    );
  }
  if (isDuplicateSessionStderr(result.stderr)) {
    // A concurrent spawn won the race — same outcome as a check-time
    // collision. The substrate never silently adopts.
    return new SessionExists(sessionName);
  }
  if (isSessionGoneStderr(result.stderr)) {
    return new SessionGone(sessionName);
  }
  return new BackendError(sessionName, argv, result.exit, result.stderr);
}

/**
 * Detail surfaced when a `Pane is dead (…)` annotation is present.
 */
export interface PaneDeadInfo {
  /**
   * Canonical signal name (e.g. `"SIGKILL"`) if the pane was killed by a
   * signal that could be identified; undefined for a normal exit (`status N`)
   * or an unrecognized token. Detection never depends on this — see below.
   */
  readonly signal: string | undefined;
}

/**
 * Detect tmux's `Pane is dead (…)` annotation (Case A, `remain-on-exit on`).
 * Returns {@link PaneDeadInfo} when the pane is dead, else `null`.
 *
 * Detection anchors ONLY on the stable `Pane is dead (` line prefix. The
 * parenthetical cause varies by platform and tmux version — `signal 9`
 * (Linux), `signal kill` (macOS), `status N` (normal exit) — so gating
 * detection on parsing it would read a dead pane as alive: a false negative.
 * The cause is parsed best-effort into a canonical signal name; an
 * unparseable cause still reports the pane as dead.
 */
export function detectPaneDeadAnnotation(stdout: string): PaneDeadInfo | null {
  if (!/^Pane is dead \(/m.test(stdout)) return null;
  const token = stdout.match(/^Pane is dead \(signal ([^,)]+)/m)?.[1];
  return { signal: token ? normalizeSignal(token.trim()) : undefined };
}

/**
 * Normalize a tmux signal token — a number (`"9"`) or a name (`"kill"`,
 * `"KILL"`, `"SIGKILL"`) — to its canonical name (`"SIGKILL"`). Backed by
 * Node's `os.constants.signals` (no hand-maintained table); names are the
 * platform-stable identity, since signal *numbers* differ across OSes.
 * Returns undefined for an unrecognized token.
 */
function normalizeSignal(token: string): string | undefined {
  const signals = osConstants.signals as Record<string, number>;
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    for (const [name, num] of Object.entries(signals)) {
      if (num === n) return name;
    }
    return undefined;
  }
  const upper = token.toUpperCase();
  const candidate = upper.startsWith("SIG") ? upper : `SIG${upper}`;
  return candidate in signals ? candidate : undefined;
}
