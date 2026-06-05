/**
 * Typed errors thrown by the claudemux substrate. Every error carries the
 * session name in its message so a consumer logging an unknown failure
 * still has the context they need.
 *
 * No bare `Error` is ever thrown from the library. The classes here are
 * exhaustive for the current public surface.
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
 * exists. The substrate never silently adopts an existing session — reconnect
 * to the live session with {@link adopt} instead.
 */
export class SessionExists extends ClaudemuxError {
  constructor(sessionName: string) {
    super(
      "session already exists; refusing to silently adopt — use adopt() to reconnect to a live session",
      sessionName,
    );
  }
}

/**
 * Thrown by {@link create} when a caller-supplied `agentSessionId` is not a
 * well-formed v4 UUID. Thrown *before spawn*, at the substrate boundary.
 *
 * @remarks
 * This is a **security boundary**, not just input hygiene. The id flows into
 * the agent's argv next to its identity flag, and into the backend's per-session
 * store and command grammar — where, in some backends, a bare `;` element can be
 * a command separator. A v4 UUID is hex + hyphens only, so it can never be `;`,
 * a path, or any token a backend would re-interpret; rejecting non-UUIDs here is
 * what keeps the always-two-argv-elements injection safe. Do not "simplify" this
 * to a loose check.
 */
export class InvalidAgentSessionId extends ClaudemuxError {
  /** The malformed value the caller passed. */
  readonly value: string;

  constructor(value: string) {
    super(
      `invalid agentSessionId ${JSON.stringify(value)}: must be a v4 UUID (e.g. the value crypto.randomUUID() produces)`,
      // No session was created — mirror InvalidSessionName's placeholder.
      "<invalid-agentSessionId>",
    );
    this.value = value;
  }
}

/**
 * Thrown by {@link create} when the caller passes an explicit
 * `agentSessionId` **and** an identity flag in `extraArgs` that also selects a
 * conversation id (claude: `--session-id`, `-r`/`--resume`, `--fork-session`).
 * The two would fight over which id the agent runs under, so the substrate
 * fails fast *before spawn* rather than silently dropping one. Pass the id one
 * way or the other, not both.
 *
 * @remarks
 * Which `extraArgs` flags count as identity flags is agent-specific knowledge,
 * so the conflict is detected inside the agent's `buildArgv` (claude owns the
 * flag vocabulary per the layering grep) and surfaced as this neutral error.
 */
export class AgentSessionIdConflict extends ClaudemuxError {
  constructor(sessionName: string) {
    super(
      "explicit agentSessionId conflicts with an identity flag in extraArgs " +
        "(e.g. --session-id / --resume / --fork-session); pass the conversation id one way, not both",
      sessionName,
    );
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
 * Thrown by **boot** ({@link create}/{@link resume}/{@link adopt}) when the REPL
 * did not reach a stable ready state within `bootTimeoutMs`. NOT thrown by
 * `wait()` — turn patience is the consumer's, so a turn that outlasts your budget
 * is a returned `budget-exceeded` {@link TurnOutcome}, never an exception.
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
 * Thrown by boot when the agent presents a workspace-trust dialog for a
 * `cwd` the substrate has not been told to trust. Trusting a folder is an
 * **authority grant** (the agent gains read/edit/execute on those files),
 * so the substrate fails closed: it does **not** auto-answer the dialog —
 * it throws this *before sending any keystroke* and leaves the decision to
 * the consumer. Pass `trustWorkspace: true` to `create` (or `--trust-workspace`
 * on the CLI) to opt in.
 *
 * @remarks
 * Opting in writes a **persistent, global, per-cwd** trust flag to the
 * agent's config (`~/.claude.json` → `projects[<abs-cwd>]`), NOT a
 * session-scoped one: it outlives the claudemux process and applies to
 * every future `claude` run in that path, including the user's own
 * interactive sessions. Trust is sticky per `(HOME × cwd-path)` — fail-closed
 * only protects the *first* run in an untrusted path; a reused checkout path
 * a prior run (or the user) already trusted inherits trust silently. For
 * untrusted-fork workloads (PR bots / CI), use an ephemeral unique checkout
 * path or an ephemeral HOME per run.
 */
export class WorkspaceUntrusted extends ClaudemuxError {
  /** The cwd the agent asked to trust. */
  readonly cwd: string;

  constructor(sessionName: string, cwd: string) {
    super(
      `workspace at ${JSON.stringify(cwd)} is not trusted; the agent asked to trust it. Pass trustWorkspace:true (or --trust-workspace) to grant the agent read/edit/execute on this folder — note this writes a persistent, per-folder trust flag to the agent's config`,
      sessionName,
    );
    this.cwd = cwd;
  }
}

/**
 * Thrown by {@link SessionHandle.respond} when the agent declares no
 * permission-prompt handling — there is no menu mapping to translate a
 * {@link PromptChoice} into a keystroke, so the substrate refuses to guess a
 * digit (a wrong guess could pick the broadest "allow all" option). An agent
 * grows prompt handling by adding the mapping to its `AgentDef`; until then a
 * consumer that hits an `awaiting{permission-prompt}` must answer the agent
 * out-of-band (or run it in a non-interactive permission mode).
 */
export class PromptResponseUnsupported extends ClaudemuxError {
  /** The agent that has no permission-prompt mapping (e.g. a future codex def). */
  readonly agentName: string;

  constructor(sessionName: string, agentName: string) {
    super(
      `agent "${agentName}" declares no permission-prompt handling; respond() has no menu mapping to answer the prompt`,
      sessionName,
    );
    this.agentName = agentName;
  }
}

/**
 * Thrown by {@link SessionHandle.messagesSince} / {@link SessionHandle.turnComplete}
 * when the session's transcript **cannot be located at all** — there is no
 * recoverable `agentSessionId` to locate it by AND no hook edge has reported its
 * path (an {@link adopt} whose recovery cache missed, a non-claudemux session, or
 * a fork before its first hook edge). Reads are *blind*, not "nothing new."
 *
 * This is a **loud** failure on purpose: an empty read silently conflated with
 * "no reply yet" sits exactly in the crash-recovery re-send path, where the wrong
 * answer double-runs work. Throwing forces the consumer to handle "I can't see
 * this conversation" distinctly. A genuinely empty (but *locatable*) transcript,
 * or an unresolvable cursor (a sentinel/garbage value), still returns empty —
 * only true unlocatability throws.
 */
export class TranscriptUnlocatable extends ClaudemuxError {
  constructor(sessionName: string) {
    super(
      "transcript cannot be located (no recoverable agentSessionId and no hook-reported path); reads are blind, not empty — persist the agentSessionId, or check `agentSessionId !== undefined` before reading",
      sessionName,
    );
  }
}

/**
 * Thrown when the underlying pane's process has died but the pane container
 * is still present in the backend's data model (Case A pane-death).
 */
export class PaneDead extends ClaudemuxError {
  /**
   * Canonical name of the signal that killed the pane process (e.g.
   * `"SIGKILL"`) — backend-neutral and platform-stable (signal *numbers*
   * differ across OSes; names do not). Undefined when the pane died from a
   * normal exit or the cause could not be identified: the error still fires,
   * the signal is best-effort diagnostic metadata.
   */
  readonly signal: string | undefined;

  constructor(sessionName: string, signal?: string) {
    super(signal ? `pane process is dead (${signal})` : "pane process is dead", sessionName);
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
 * Thrown by {@link create} when the agent process **exits before the session
 * becomes ready** — claudemux spawned it, but it was gone (its backend session
 * reaped) before boot could reach an interactive prompt.
 *
 * @remarks
 * **The most common cause is an `agentSessionId` collision:** claude refuses to
 * silently resume or clobber an in-use conversation id — it prints
 * "Session ID … is already in use" and exits. But a malformed `extraArgs` flag,
 * an auth edge, or any startup crash produce the *identical* shape, and
 * claudemux **cannot read which** — the substrate runs panes with
 * `remain-on-exit off`, so claude's stderr is reaped before boot can capture
 * it. That is the same deliberate property that lets {@link adopt} hand back a
 * clean {@link SessionGone} for a crashed agent instead of a corpse handle, so
 * we do not flip it to recover a diagnostic string.
 *
 * This is a distinct class on purpose (errors.ts reuses before adding):
 * {@link PaneDead} is a dead process whose pane is still *present* (only under
 * `remain-on-exit on`); {@link SessionGone} reads as *external* reaping of a
 * session that should exist. Neither carries the meaning the create path needs
 * — *"the agent I just spawned rejected its own launch"* (self-inflicted exit
 * vs external interference) — which is exactly what the consumer must act on.
 *
 * When the spawn used a caller-chosen id, it is carried on
 * {@link agentSessionId} so the collision case stays actionable as structured
 * data (pick another id, or resume that conversation) without scraping text.
 *
 * **Deferred precision:** once a `transcriptPath` helper lands (owning claude's
 * cwd-slug rule in `claude.ts` per the layering grep), a pre-spawn transcript
 * probe can upgrade the collision case to a precise `AgentSessionInUse` and
 * fall back to this error for the other death causes — a non-breaking addition.
 */
export class AgentExitedDuringBoot extends ClaudemuxError {
  /** The caller-chosen id the spawn used, if any — the likely collision culprit. */
  readonly agentSessionId?: string;

  constructor(sessionName: string, agentSessionId?: string) {
    const withId =
      agentSessionId !== undefined
        ? ` (spawned with agentSessionId ${agentSessionId}, which is most likely already in use)`
        : "";
    super(
      `the agent exited before the session became ready${withId}; the most common cause is an agentSessionId collision (the agent refuses to resume silently and exits)`,
      sessionName,
    );
    if (agentSessionId !== undefined) this.agentSessionId = agentSessionId;
  }
}

/**
 * Discriminates *why* the backend is unreachable. Recovery code branches on
 * this: `no-server` is a legitimate "nothing is running yet" (query verbs
 * treat it as absence), whereas `spawn-failed` (binary missing) and
 * `timeout` (wedged backend) are real faults that must surface loudly — a
 * missing dependency or a hung process must never masquerade as "no
 * sessions exist."
 */
export type BackendUnreachableKind = "no-server" | "spawn-failed" | "timeout";

/**
 * Thrown when the underlying backend (the agent's I/O substrate) is
 * unreachable — the backend process failed to spawn (`spawn-failed`), its
 * server was not running on the requested connection (`no-server`), or a
 * backend invocation hung past its budget (`timeout`).
 */
export class BackendUnreachable extends ClaudemuxError {
  /** Why the backend was unreachable — see {@link BackendUnreachableKind}. */
  readonly kind: BackendUnreachableKind;
  /** The underlying spawn / connection error, if available. */
  readonly underlying?: Error;

  constructor(sessionName: string, kind: BackendUnreachableKind, underlying?: Error) {
    super(
      `backend unreachable [${kind}]${underlying ? ` (${underlying.message})` : ""}`,
      sessionName,
    );
    this.kind = kind;
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
