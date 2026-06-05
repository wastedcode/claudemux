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
 * usable agent, it falls back to `resume()` — continue the conversation in a
 * fresh pane.
 */

import {
  type AgentDef,
  LoginRequired,
  SessionGone,
  type SessionHandle,
  adopt,
  claude,
  resume,
} from "claudemux";

/**
 * What the daemon persisted per session. You MUST persist BOTH:
 *
 *  - `agentSessionId` feeds `resume()` and fails LOUDLY if you forget it — you
 *    have nothing to continue and start fresh (or error), and notice at once.
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

/** Continue the conversation in a fresh pane (States A / B / C all land here). */
async function reattachFresh(name: string, p: Persisted): Promise<SessionHandle> {
  // The old pane is gone (A) or has been killed (B/C), so the name is free.
  return resume({
    name,
    cwd: process.cwd(),
    agent: AGENTS[p.agentDefId] ?? claude,
    agentSessionId: p.agentSessionId,
  });
}

// This shows the recovery dance by hand (adopt → state() → resume) AND adds a
// wedged-pane (state B) check the `recover()` compound deliberately leaves to you.
// If you just need attach-or-resume, call `recover()` instead of all of this.
/** Re-adopt one persisted session, walking the A (gone) / B (wedged) decision tree. */
async function reattachOne(name: string, p: Persisted): Promise<SessionHandle> {
  const agent = AGENTS[p.agentDefId] ?? claude;

  let session: SessionHandle;
  try {
    session = await adopt({ name, agent });
  } catch (err) {
    if (err instanceof SessionGone) {
      // State A — the process exited (a crashed `claude` tears down the whole
      // session, so absence is clean). Resume the conversation in a fresh pane.
      return reattachFresh(name, p);
    }
    throw err;
  }

  // The pane is live, but "live" is not "usable". ALWAYS read state() before
  // driving it — adopt() is a pure attach and dismisses nothing. state() is the
  // fused snapshot (NOT wait(), which waits on an in-flight TURN — a healthy
  // idle session has none, so wait() would budget-exceed and falsely read wedged).
  let st: Awaited<ReturnType<SessionHandle["state"]>>;
  try {
    st = await session.state();
  } catch (err) {
    if (err instanceof SessionGone) {
      // Also State A — the pane vanished between adopt() and this read (a
      // mid-check crash). kill() is idempotent; resume in a fresh pane.
      await session.kill();
      return reattachFresh(name, p);
    }
    throw err;
  }

  if (st === "unknown") {
    // State B — wedged / unrecognized: the pane is attached but the substrate
    // can't make sense of it. Kill it THEN resume in a fresh pane.
    await session.kill();
    return reattachFresh(name, p);
  }

  // idle / working / dialog → reconnected, no conversation lost (a `working`
  // pane is a turn still legitimately in flight — let it run).
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
      const session = await reattachOne(name, persisted);
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
