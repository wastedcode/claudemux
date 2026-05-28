import { randomBytes } from "node:crypto";

/**
 * Mint a unique tmux socket name for one test. The `-L <name>` flag isolates
 * the test's tmux server from any user-owned server on the machine.
 *
 * The `-f /dev/null` flag is the actual "never reads `~/.tmux.conf`"
 * guarantee — see `engineer/wiki/tmux-private-server-bootstrap`. Both are
 * required on every tmux invocation; this helper always emits both.
 */
export function mintSocket(): string {
  // Short enough to keep argv readable, long enough that two tests cannot collide.
  return `claudemux-test-${randomBytes(6).toString("hex")}`;
}

/**
 * Build a tmux argv prefix with the test's private socket + the no-config flag.
 *
 * @example
 * ```ts
 * await run("tmux", tmuxArgs(socket, "new-session", "-d", "-s", "x"));
 * ```
 */
export function tmuxArgs(socket: string, ...rest: string[]): string[] {
  return ["-L", socket, "-f", "/dev/null", ...rest];
}
