/**
 * Re-adopt live sessions after a daemon/process restart — the full recovery
 * decision tree a long-lived orchestrator must write.
 *
 * This file imports from the published package name (`claudemux`), not
 * `../src/index.js` — so it runs the same way a consumer would after
 * `npm install claudemux`.
 *
 * **Illustrative, NOT a CI gate.** Like `spawn-send-wait-capture.ts`, this
 * cannot run green without auth: the State-A re-`create()` path throws
 * `LoginRequired` in a fresh `~/.claude/`. The in-repo restart round-trip
 * (`test/session/adopt.test.ts`, criterion #4) is what gives CI teeth; this
 * example is the human-readable map of the journey.
 *
 * The shape: a daemon persisted some sessions before it restarted. On boot it
 * re-adopts each one, and for every way an adopt can fail to hand back a
 * usable agent, it falls back to re-creating with `--resume`.
 */

import {
  type AgentDef,
  LoginRequired,
  PaneDead,
  ReplTimeout,
  SessionGone,
  type SessionHandle,
  adopt,
  claude,
  create,
} from "claudemux";

/**
 * What the daemon persisted per session. You MUST persist BOTH:
 *
 *  - `agentSessionId` feeds `--resume` and fails LOUDLY if you forget it —
 *    re-`create()` simply starts a fresh conversation (or errors), and you
 *    notice at once.
 *  - `agentDefId` selects which `AgentDef` to re-pass to `adopt()`. Forgetting
 *    or mismatching it fails SILENTLY: `state()`/`wait()` classify the live
 *    pane against the WRONG agent's rules and quietly lie. Harmless while
 *    `claude` is the only agent you ship; armed the day you ship a custom one.
 */
interface Persisted {
  agentSessionId: string;
  agentDefId: string;
}

// The agent registry: persisted `agentDefId` → the live AgentDef to re-pass.
// This is the "persist-both" pattern — the def must round-trip with the id.
const AGENTS: Record<string, AgentDef> = { claude };

// Stand-in for the daemon's durable store (a DB / file in real life).
const store: Record<string, Persisted> = {
  "job-a": { agentSessionId: "sess_aaa", agentDefId: "claude" },
  "job-b": { agentSessionId: "sess_bbb", agentDefId: "claude" },
};

/** Re-create a session from its persisted resume id (States A / B / C all land here). */
async function recreate(name: string, p: Persisted): Promise<SessionHandle> {
  return create({
    name,
    cwd: process.cwd(),
    agent: AGENTS[p.agentDefId] ?? claude,
    extraArgs: ["--resume", p.agentSessionId],
  });
}

/** Re-adopt one persisted session, walking the A/B/C recovery decision tree. */
async function recover(name: string, p: Persisted): Promise<SessionHandle> {
  const agent = AGENTS[p.agentDefId] ?? claude;

  let session: SessionHandle;
  try {
    session = await adopt({ name, agent });
  } catch (err) {
    if (err instanceof SessionGone) {
      // State A — the process exited (a crashed `claude` tears down the whole
      // session, so absence is clean). Re-create with --resume.
      return recreate(name, p);
    }
    throw err;
  }

  // The pane is live, but "live" is not "usable". ALWAYS call state() before
  // driving it — adopt() is a pure attach and dismisses nothing.
  try {
    await session.state();
  } catch (err) {
    if (err instanceof PaneDead) {
      // State C — the pane container survives but its process is dead. Kill the
      // husk, then re-create with --resume.
      await session.kill();
      return recreate(name, p);
    }
    throw err;
  }

  try {
    // A bounded wait() surfaces State B: the pane is attached but wedged and
    // never settles to an actionable state. Treat the timeout as "wedged".
    await session.wait({ timeoutMs: 30_000 });
  } catch (err) {
    if (err instanceof ReplTimeout) {
      // State B — wedged. Kill it THEN re-create with --resume.
      await session.kill();
      return recreate(name, p);
    }
    throw err;
  }

  // Reached an actionable state on the live pane — the win: reconnected, no
  // conversation lost, no re-create needed.
  return session;
}

async function main(): Promise<void> {
  try {
    // Recovery-storm guard (README §adopt): if you are recovering MANY sessions
    // and they ALL report SessionGone at once, that is a server-restart event,
    // not N independent deaths — probe list()/exists() once for the batch before
    // re-creating, or you re-spawn N sessions against a just-restarted host. This
    // loop recovers one at a time for clarity; a batch recoverer must back off.
    for (const [name, persisted] of Object.entries(store)) {
      const session = await recover(name, persisted);
      process.stdout.write(`recovered ${name} → ${await session.state()}\n`);
    }
  } catch (err) {
    if (err instanceof LoginRequired) {
      process.stderr.write(
        "claudemux: claude is not authenticated. Run `claude` interactively once to sign in, then re-run this script.\n",
      );
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
