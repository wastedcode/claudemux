/**
 * The `Backend` seam — drives a named pane: spawn a process, send input,
 * capture output, kill. Knows **nothing** about claude or any specific agent.
 *
 * This file is internal. The public surface (`src/index.ts`) does NOT
 * re-export `Backend`, `SendPayload`, or `BackendEvent`.
 *
 * Two input primitives only — `paste` (multi-line safe) and `key` (named).
 * There is no `sendRawText`: multi-line input that would submit per-line
 * cannot leak around this seam.
 */

/** A single backend-issued operation observable via `Backend.onCommand`. */
export interface BackendEvent {
  /** Unix epoch milliseconds when the command was issued. */
  ts: number;
  /** The argv the substrate spawned. */
  argv: string[];
  /** Wall-clock milliseconds the command took. */
  durationMs: number;
  /** Process exit code. */
  exit: number;
  /** Captured stdout, if any. */
  stdout?: string;
  /** Captured stderr, if any. */
  stderr?: string;
}

/**
 * The shape of one backend write. Multi-line input rides as `paste`;
 * submission and dialog responses ride as `key`.
 */
export type SendPayload =
  | { kind: "paste"; text: string }
  | { kind: "key"; key: "Enter" | "Escape" | "1" | "2" | "y" | "n" };

/**
 * The substrate's view of one named pane in a backend. Implemented by
 * `src/backends/tmux/index.ts` for v0.0.1; future backends (node-pty,
 * `CustomPaneBackend`) implement the same interface.
 */
export interface Backend {
  /** The backend's short identifier (e.g. `"tmux"`). For diagnostics only. */
  readonly id: string;

  /** Create a named session running `cmd` + `argv` in `cwd`. */
  spawn(o: {
    namespace: string;
    name: string;
    cwd: string;
    env?: Record<string, string>;
    cmd: string;
    argv: string[];
  }): Promise<void>;

  /** Kill the named session. Idempotent — kill of a missing session is success. */
  kill(name: string): Promise<void>;

  /** Whether the named session is alive. */
  exists(name: string): Promise<boolean>;

  /** List session names owned by `namespace`. */
  list(namespace: string): Promise<string[]>;

  /** Send one payload to the named session. */
  send(name: string, payload: SendPayload): Promise<void>;

  /**
   * Return the named session's pane text.
   * @param o.ansi — preserve escape sequences when `true`.
   * @param o.lines — return only the bottom-N lines (default: full visible region).
   */
  capture(name: string, o?: { ansi?: boolean; lines?: number }): Promise<string>;

  /** Subscribe to every backend command + result. Returns an unsubscribe fn. */
  onCommand(handler: (e: BackendEvent) => void): () => void;
}
