import { SessionGone } from "../../errors.js";
import { PANE_HEIGHT } from "../../session/constants.js";
import { type TmuxExec, classifyTmuxFailure, isNoServer, isSessionGoneStderr } from "./exec.js";
import { serverOptionsArgv } from "./options.js";

/**
 * Build the namespaced tmux session target name from `namespace` + `name`.
 * The namespace prefix is what lets two consumers + manual user tmux
 * sessions coexist on one private server without collision.
 *
 * The separator is `--` because `:` and `.` are reserved by tmux's target
 * grammar (`session:window.pane`) — a colon-separated name would parse as
 * "session=<namespace>, window=<name>" and trip "no such window" errors.
 */
export function targetOf(namespace: string, name: string): string {
  return `${namespace}--${name}`;
}

/**
 * Create a new tmux session running `cmd` + `argv` in `cwd`, with the
 * substrate's server-global options set in the same invocation so they
 * land before the agent's pane is allocated.
 *
 * Per-session environment (including `LC_ALL=C.UTF-8` for unicode glyph
 * stability — a substrate concern, not an agent one) rides on `new-session
 * -e KEY=VAL` pairs. `-e` on `new-session` is tmux ≥3.2; that sets the
 * substrate's supported floor (see README §Compatibility / details.md
 * §Quality). `set-environment` after `new-session` is not an option — it
 * doesn't affect the already-spawned pane process.
 */
export async function newSession(
  exec: TmuxExec,
  o: {
    namespace: string;
    name: string;
    cwd: string;
    env?: Record<string, string>;
    cmd: string;
    argv: string[];
    /** User-facing label for error messages (defaults to tmux target encoding). */
    label?: string;
  },
): Promise<void> {
  const target = targetOf(o.namespace, o.name);
  const label = o.label ?? target;

  // LC_ALL=C.UTF-8 is the substrate's default locale; `o.env` may override or
  // augment it. Merging into one object dedupes the key, so the agent passing
  // `env: { LC_ALL }` (claude does) doesn't produce a duplicate `-e` flag.
  const env: Record<string, string> = { LC_ALL: "C.UTF-8", ...o.env };
  const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const newSessionCmd = [
    "new-session",
    "-d",
    "-s",
    target,
    "-x",
    "120",
    "-y",
    // Pane height = the classifier's scan cap; one source so they can't drift.
    String(PANE_HEIGHT),
    ...envFlags,
    "-c",
    o.cwd,
    o.cmd,
    ...o.argv,
  ];

  // Combine server-options + new-session into ONE tmux invocation so the
  // globals land in the same client connection that creates the session.
  // The server only stays alive once a session exists, so `start-server`
  // followed by `set-option -g` doesn't work — globals must be set in the
  // same invocation that registers the first session.
  const argv = [...serverOptionsArgv(), ...newSessionCmd];
  const r = await exec.run(argv, { sessionName: label });
  const err = classifyTmuxFailure(label, ["tmux", ...argv], r);
  if (err) throw err;
}

/**
 * Is the named session currently alive on the server?
 *
 * Returns `false` (never throws) for "the session isn't here":
 *   - exit 0 → `true`
 *   - `can't find session/window/pane: …` (any level of tmux's target
 *     grammar) → `false`, via `isSessionGoneStderr`. A name that trips the
 *     `session:window.pane` parser still yields a boolean, not a throw.
 *   - `no-server` BackendUnreachable (empty/down server) → `false`.
 *
 * It DOES throw `BackendUnreachable` for `spawn-failed` (backend binary
 * missing) and `timeout` (wedged backend) — those are real faults; a missing
 * dependency must not masquerade as "no such session." The no-server gate
 * lives solely in the catch (exec.run rejects no-server before it could
 * resolve), so there is no dead resolve-path branch here.
 *
 * `label` is the user-facing identifier used in error messages (defaults to
 * `target`). Errors thrown from this function carry `label`, not the tmux
 * internal target encoding.
 */
export async function hasSession(
  exec: TmuxExec,
  target: string,
  label: string = target,
): Promise<boolean> {
  try {
    const r = await exec.run(["has-session", "-t", target], { sessionName: label });
    if (r.exit === 0) return true;
    if (isSessionGoneStderr(r.stderr)) return false;
    const err = classifyTmuxFailure(label, ["tmux", "has-session", "-t", target], r);
    if (err) throw err;
    return false;
  } catch (err) {
    if (isNoServer(err)) return false; // empty server == no such session
    throw err; // spawn-failed (binary missing) / timeout (wedged) surface loudly
  }
}

/**
 * Kill a session by target name. Idempotent — "session was already gone" or
 * "no server running" is treated as success. A *missing backend binary*
 * (`spawn-failed`) or a *wedged* server (`timeout`) still throws — those are
 * real faults, not "the session is already gone."
 */
export async function killSession(
  exec: TmuxExec,
  target: string,
  label: string = target,
): Promise<void> {
  try {
    const r = await exec.run(["kill-session", "-t", target], { sessionName: label });
    if (r.exit === 0) return;
    const err = classifyTmuxFailure(label, ["tmux", "kill-session", "-t", target], r);
    if (err instanceof SessionGone) return;
    if (err) throw err;
  } catch (err) {
    if (isNoServer(err)) return; // empty server == no session to kill
    throw err;
  }
}

/**
 * List the *short* session names within `namespace` (the piece after the
 * `<namespace>--` prefix), in whatever order tmux reports. A running-but-empty
 * server, or no server at all, returns `[]`. A missing backend binary or a
 * wedged server throws `BackendUnreachable` — an empty list must mean "no
 * sessions," never "we couldn't reach the backend."
 */
export async function listSessions(exec: TmuxExec, namespace: string): Promise<string[]> {
  let r: Awaited<ReturnType<TmuxExec["run"]>>;
  try {
    r = await exec.run(["list-sessions", "-F", "#{session_name}"], { sessionName: namespace });
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
  if (r.exit !== 0) {
    if (r.stdout.trim() === "") return [];
    const err = classifyTmuxFailure(namespace, ["tmux", "list-sessions"], r);
    if (err) throw err;
  }
  const prefix = `${namespace}--`;
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}
