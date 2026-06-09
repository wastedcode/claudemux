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
  | { kind: "key"; key: "Enter" | "Escape" | "1" | "2" | "3" | "y" | "n" };

/**
 * Identifier for one named session. Every Backend method takes this shape
 * so the backend owns its own naming convention — callers never construct
 * `<namespace>--<name>` or any other concrete encoding. Future backends
 * (node-pty, CustomPaneBackend) implement the same interface and may
 * encode the pair differently internally.
 */
export interface SessionRef {
  namespace: string;
  name: string;
}

/**
 * Format a {@link SessionRef} as the human-readable label used in error
 * messages and observability output. The substrate's public label format
 * is `<namespace>/<name>` — distinct from any backend's internal encoding
 * (the tmux backend, for example, uses `<namespace>--<name>` internally).
 *
 * One place; one format; rename here if the user-facing label ever changes
 * (e.g. to `<namespace>:<name>`).
 */
export function formatSessionLabel(ref: SessionRef): string {
  return `${ref.namespace}/${ref.name}`;
}

/**
 * The substrate's view of one named pane in a backend. Implemented by
 * `src/backends/tmux/index.ts` currently; future backends (node-pty,
 * `CustomPaneBackend`) implement the same interface.
 */
export interface Backend {
  /** The backend's short identifier (e.g. `"tmux"`). For diagnostics only. */
  readonly id: string;

  /** Create a named session running `cmd` + `argv` in `cwd`. */
  spawn(
    o: SessionRef & {
      cwd: string;
      env?: Record<string, string>;
      cmd: string;
      argv: string[];
      /**
       * Env var names to genuinely UNSET for the spawned process — see
       * {@link AgentDef.buildArgv}'s `unsetEnv`. The backend emits this however
       * its substrate truly unsets a var (a name also in `env` stays SET).
       */
      unsetEnv?: string[];
    },
  ): Promise<void>;

  /** Kill the named session. Idempotent — kill of a missing session is success. */
  kill(ref: SessionRef): Promise<void>;

  /** Whether the named session is alive. */
  exists(ref: SessionRef): Promise<boolean>;

  /** List short session names owned by `namespace`. */
  list(namespace: string): Promise<string[]>;

  /** Send one payload to the named session. */
  send(ref: SessionRef, payload: SendPayload): Promise<void>;

  /**
   * Return the named session's pane text.
   * @param o.ansi — preserve escape sequences when `true`.
   * @param o.lines — return only the bottom-N lines (default: full visible region).
   */
  capture(ref: SessionRef, o?: { ansi?: boolean; lines?: number }): Promise<string>;

  /**
   * Persist a small opaque string under a **session-scoped** key. The value
   * lives and dies with the session. Used for cross-process coordination —
   * specifically the post-submit pane fingerprint `send()` leaves for a later
   * (possibly different-process) `wait()` to read. Backend-specific storage
   * (the tmux backend uses a `@`-prefixed session user option); callers treat
   * it as an opaque per-session key/value store and never depend on where it
   * lives.
   */
  setSessionMeta(ref: SessionRef, key: string, value: string): Promise<void>;

  /**
   * Read a value previously written via {@link setSessionMeta}. Returns
   * `undefined` when the key was never set (or the session/value is
   * unreadable) — it is metadata, so absence is not an error.
   */
  getSessionMeta(ref: SessionRef, key: string): Promise<string | undefined>;

  /** Subscribe to every backend command + result. Returns an unsubscribe fn. */
  onCommand(handler: (e: BackendEvent) => void): () => void;
}
