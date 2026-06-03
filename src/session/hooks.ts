import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "../agents/types.js";

/**
 * Hook injection for the observe side. claudemux observes a session reliably
 * via agent **hooks** (deterministic, harness-fired) + the transcript — never
 * by scraping the TUI. On spawn we inject the agent's hook settings (default
 * on) so the agent appends turn-lifecycle markers to a claudemux-owned local
 * rendezvous file; the Observer reads them as phase edges.
 *
 * This module owns the claudemux-side mechanism (where the rendezvous lives,
 * whether to inject); the agent owns the hook *vocabulary* (which events, the
 * settings shape) behind {@link AgentDef.hooks}. No agent flag strings here.
 */

/**
 * The claudemux-owned local rendezvous file for a session's hook turn-markers.
 * Local, absolute, no network (honors the trust posture). `.ndjson` (not the
 * agent's `.jsonl` transcript) keeps the two stores distinct.
 */
export function rendezvousPathFor(sessionId: string): string {
  const stateDir = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateDir, "claudemux", "turns", `${sessionId}.ndjson`);
}

/**
 * Compute the hook injection for a spawn.
 *
 * @returns `args` — extra argv to prepend so the agent emits turn markers to
 *   `rendezvousPath` (the Observer reads it). Both empty/absent when hooks are
 *   disabled, the agent has none, or the consumer already supplied the agent's
 *   hook flag (we don't double-inject — deep-merging the consumer's settings
 *   with ours is a hardening follow-up).
 */
export function buildHookInjection(o: {
  agent: AgentDef;
  sessionId: string;
  enabled: boolean;
  userExtraArgs: readonly string[];
}): { args: string[]; rendezvousPath?: string } {
  if (!o.enabled || o.agent.hooks === undefined) return { args: [] };
  const rendezvousPath = rendezvousPathFor(o.sessionId);
  const spec = o.agent.hooks.spec({ rendezvousPath });
  const alreadySet = o.userExtraArgs.some((a) => a === spec.flag || a.startsWith(`${spec.flag}=`));
  if (alreadySet) return { args: [] };
  return { args: [spec.flag, spec.value], rendezvousPath };
}
