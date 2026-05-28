import { SessionGone } from "../../errors.js";
import { type TmuxExec, classifyTmuxFailure } from "./exec.js";
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
 * Create a new tmux session running `cmd` + `argv` in `cwd`. Applies the
 * substrate's five per-session options before the agent process starts.
 *
 * Uses the two-step holder-pane / `respawn-pane -k` startup so the options
 * land before the agent's pane is allocated — `history-limit` is allocated
 * at pane creation, and `set-environment` only affects future spawns.
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
  },
): Promise<void> {
  const target = targetOf(o.namespace, o.name);

  // Build new-session argv. Env vars (caller-supplied) ride on `-e KEY=VAL`
  // pairs at new-session time — `set-environment` after new-session would
  // not affect the already-spawned pane process.
  const envFlags = o.env ? Object.entries(o.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
  const newSessionCmd = [
    "new-session",
    "-d",
    "-s",
    target,
    "-x",
    "120",
    "-y",
    "40",
    "-e",
    "LC_ALL=C.UTF-8",
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
  const r = await exec.run(argv, { sessionName: target });
  const err = classifyTmuxFailure(target, ["tmux", ...argv], r);
  if (err) throw err;
}

/** Is the named session currently alive on the server? */
export async function hasSession(exec: TmuxExec, target: string): Promise<boolean> {
  try {
    const r = await exec.run(["has-session", "-t", target], { sessionName: target });
    if (r.exit === 0) return true;
    if (/can't find session:/i.test(r.stderr)) return false;
    // "error connecting to /tmp/.../sock (No such file or directory)" is the
    // empty-server form on some versions — semantically the same as "no session."
    if (looksLikeNoServer(r.stderr)) return false;
    const err = classifyTmuxFailure(target, ["tmux", "has-session", "-t", target], r);
    if (err) throw err;
    return false;
  } catch (err) {
    if (err instanceof Error && looksLikeNoServer(err.message)) return false;
    throw err;
  }
}

/** True when tmux's stderr indicates the server is not running on the socket. */
function looksLikeNoServer(text: string): boolean {
  return /no server running on/i.test(text) || /error connecting to /i.test(text);
}

/**
 * Kill a session by target name. Idempotent — "session was already gone" or
 * "no server running" is treated as success.
 */
export async function killSession(exec: TmuxExec, target: string): Promise<void> {
  try {
    const r = await exec.run(["kill-session", "-t", target], { sessionName: target });
    if (r.exit === 0) return;
    if (looksLikeNoServer(r.stderr)) return; // empty server == no session
    const err = classifyTmuxFailure(target, ["tmux", "kill-session", "-t", target], r);
    if (err instanceof SessionGone) return;
    if (err) throw err;
  } catch (err) {
    if (err instanceof Error && looksLikeNoServer(err.message)) return;
    throw err;
  }
}

/**
 * List session names within `namespace`. Returns the *short* names (the
 * piece after `<namespace>:`), in whatever order tmux reports. An empty
 * list (no sessions at all, OR no server running) returns `[]`.
 */
export async function listSessions(exec: TmuxExec, namespace: string): Promise<string[]> {
  let r: Awaited<ReturnType<TmuxExec["run"]>>;
  try {
    r = await exec.run(["list-sessions", "-F", "#{session_name}"], { sessionName: namespace });
  } catch (err) {
    if (err instanceof Error && looksLikeNoServer(err.message)) return [];
    throw err;
  }
  if (r.exit !== 0) {
    if (looksLikeNoServer(r.stderr)) return [];
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
