/**
 * Typed errors thrown by the claudemux substrate. Every error carries the
 * session name in its message so a consumer logging an unknown failure
 * still has the context they need.
 *
 * No bare `Error` is ever thrown from the library. The classes here are
 * exhaustive for v0.0.1.
 */

/** Base class — consumers can `catch (e: ClaudemuxError)` for the union. */
export class ClaudemuxError extends Error {
  /** The session this error pertains to. */
  readonly sessionName: string;

  constructor(message: string, sessionName: string) {
    super(`[claudemux:${sessionName}] ${message}`);
    this.name = new.target.name;
    this.sessionName = sessionName;
  }
}

/**
 * Thrown by {@link create} when a session with the requested name already
 * exists. The substrate never silently adopts an existing session.
 */
export class SessionExists extends ClaudemuxError {
  constructor(sessionName: string) {
    super("session already exists; refusing to silently adopt", sessionName);
  }
}

/**
 * Thrown by the boot orchestrator when a recognized dialog matches but its
 * response did not advance the pane within the dialog timeout.
 */
export class DialogStuck extends ClaudemuxError {
  /** The matched dialog's id (e.g. `"theme-picker"`). */
  readonly dialogId: string;

  constructor(sessionName: string, dialogId: string) {
    super(`dialog "${dialogId}" matched but did not advance after response`, sessionName);
    this.dialogId = dialogId;
  }
}

/**
 * Thrown by `wait()` or boot when the REPL did not reach an actionable
 * state (idle / permission-prompt / dialog) within the configured timeout.
 */
export class ReplTimeout extends ClaudemuxError {
  /** The timeout budget that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(sessionName: string, timeoutMs: number) {
    super(`REPL did not settle within ${timeoutMs}ms`, sessionName);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by boot when the login-method dialog fires — claudemux assumes the
 * founder is already authenticated, so this dialog firing under claudemux is
 * a setup error, not an auto-answerable dialog.
 */
export class LoginRequired extends ClaudemuxError {
  constructor(sessionName: string) {
    super(
      "claude is not authenticated; the login-method dialog appeared. " +
        "Run `claude` interactively once to sign in, then retry",
      sessionName,
    );
  }
}

/**
 * Thrown when the underlying pane's process has died but the pane container
 * is still present in the backend's data model (Case A pane-death).
 */
export class PaneDead extends ClaudemuxError {
  /** Signal number reported by the backend, if available. */
  readonly signal: number;

  constructor(sessionName: string, signal: number) {
    super(`pane process is dead (signal ${signal})`, sessionName);
    this.signal = signal;
  }
}

/**
 * Thrown when the backend cannot find the named session at all (Case B —
 * the pane has been reaped). Includes "the session was already gone before
 * we touched it" — kill() never throws this.
 */
export class SessionGone extends ClaudemuxError {
  constructor(sessionName: string) {
    super("session is gone", sessionName);
  }
}

/**
 * Thrown when the underlying backend (the agent's I/O substrate) is
 * unreachable — the backend process failed to spawn, its socket is
 * missing, or its server was not running on the requested connection.
 */
export class BackendUnreachable extends ClaudemuxError {
  /** The underlying spawn / connection error, if available. */
  readonly underlying?: Error;

  constructor(sessionName: string, underlying?: Error) {
    super(`backend unreachable${underlying ? ` (${underlying.message})` : ""}`, sessionName);
    if (underlying !== undefined) {
      this.underlying = underlying;
    }
  }
}

/**
 * Thrown by `create` / `spawn` when the session name or namespace contains
 * characters that the substrate cannot encode safely for the backend's
 * target grammar. The substrate fails fast at the boundary instead of
 * silently renaming and producing an un-addressable handle.
 *
 * @remarks
 * Reserved set: `.`, `:`, `*`, `?`, leading `-`, any whitespace, `/`,
 * `\n`, `\r`, `\\`, and the empty string.
 */
export class InvalidSessionName extends ClaudemuxError {
  /** Which field was invalid (`"name"` or `"namespace"`). */
  readonly field: "name" | "namespace";
  /** The actual value the caller passed. */
  readonly value: string;
  /** The reason the value is rejected. */
  readonly reason: string;

  constructor(field: "name" | "namespace", value: string, reason: string) {
    super(
      `invalid ${field} ${JSON.stringify(value)}: ${reason}`,
      // Use the offending value itself so the error has *some* identifier.
      // The session was never created; there is no real name to use.
      `<invalid-${field}>`,
    );
    this.field = field;
    this.value = value;
    this.reason = reason;
  }
}

/**
 * Wrapper for an unexpected backend failure that isn't one of the typed
 * cases above (non-zero exit + unrecognized stderr).
 *
 * @remarks
 * The `.message` deliberately **excludes the backend argv** — the argv is
 * pure backend vocabulary (the backend's own subcommand names) and leaking
 * it into the user-facing message violates the substrate's "zero references
 * to the backend in error messages" promise. The argv lives on `.argv` (and
 * flows through `onBackendCommand`) for programmatic diagnosis; the
 * human-readable message carries the exit code and the backend's own stderr
 * text, which is the diagnostic value without the command vocabulary.
 *
 * This is the structural backstop behind the backend classifier's
 * routine-case promotion: even a backend failure shape we haven't classified
 * yet cannot leak the backend's command names into user-facing text.
 */
export class BackendError extends ClaudemuxError {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(sessionName: string, argv: readonly string[], exitCode: number, stderr: string) {
    super(
      `backend command failed (exit ${exitCode}): ${stderr.trim() || "<empty stderr>"}`,
      sessionName,
    );
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
