/**
 * Test-harness wrapper around the substrate's socket-minting helper plus a
 * convenience for the test's tmux argv prefix. The minting logic itself
 * lives in the substrate (`src/backends/tmux/socket.ts`) so tests and
 * production agree on the socket-name shape.
 */
export { mintSocket } from "../../src/backends/tmux/socket.js";

/**
 * Build a tmux argv prefix with the test's private socket + the no-config flag.
 * Used by harness.test.ts for the discipline check; production code goes
 * through `TmuxExec.run` which enforces the same prefix on every invocation.
 */
export function tmuxArgs(socket: string, ...rest: string[]): string[] {
  return ["-L", socket, "-f", "/dev/null", ...rest];
}
