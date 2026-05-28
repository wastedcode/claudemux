import { randomBytes } from "node:crypto";

/**
 * Mint a unique tmux socket name. The substrate uses one socket per process
 * (different consumers + different test runners get isolated servers).
 *
 * Every tmux invocation in `backends/tmux/exec.ts` prepends both
 * `-L <socket>` (socket isolation) and `-f /dev/null` (no `~/.tmux.conf`).
 */
export function mintSocket(): string {
  return `claudemux-${randomBytes(6).toString("hex")}`;
}
