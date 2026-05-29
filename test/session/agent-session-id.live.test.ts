import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentExitedDuringBoot } from "../../src/errors.js";
import { create } from "../../src/session/create.js";
import type { SessionHandle } from "../../src/types.js";

/**
 * Live `agentSessionId` round-trip against a REAL authenticated claude — the
 * dogfood proof (be customer #1, not "the parts exist by inspection"):
 *
 *   1. the id `create()` returns is the id claude actually ran under — its
 *      transcript lands at `~/.claude/projects/<cwd-slug>/<id>.jsonl`;
 *   2. **resume rides `extraArgs`** (`--resume <id>`) with NO new code — a
 *      second session resumes the first conversation and recalls a planted
 *      token;
 *   3. a **collision** (`create({ agentSessionId })` on an id that already has
 *      a transcript) surfaces a typed `AgentExitedDuringBoot`, fast — never a
 *      silent resume, never a hang. (This is the interactive-mode behavior the
 *      ticket-C recheck observed on-box: claude exits, the pane is reaped under
 *      `remain-on-exit off`, and boot maps the reap to the typed error.)
 *
 * Like `interrupt.live.test.ts`, this spawns a real claude, so it is excluded
 * from the gate suite (see `vitest.config.ts`) and runs only when
 * `CLAUDEMUX_LIVE_AGENT_SESSION_ID=1` under the network-isolated live workflow.
 * It self-skips cleanly otherwise.
 */
const LIVE = process.env.CLAUDEMUX_LIVE_AGENT_SESSION_ID === "1";

/** Derive claude's transcript path from `(cwd, id)`. The cwd-slug rule — every
 * `/` becomes `-` (so a leading `/` yields a leading `-`) — is claude-storage
 * detail observed on-box; claudemux ships no `transcriptPath` helper this
 * release, so the consumer derives it exactly like this. */
function transcriptPath(cwd: string, id: string): string {
  const slug = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", slug, `${id}.jsonl`);
}

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = "PLANTED_TOKEN_70413";

describe("agentSessionId — live round-trip (resume + transcript location)", () => {
  if (!LIVE) {
    it.skip("auth-gated — set CLAUDEMUX_LIVE_AGENT_SESSION_ID=1 under the network-isolated live workflow to enable", () => {});
    return;
  }

  let cwd: string;
  let createdId: string;
  const sessions: SessionHandle[] = [];

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudemux-asid-live-"));
  });

  afterAll(async () => {
    for (const s of sessions) await s.kill().catch(() => undefined);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("create() returns the id claude ran under; its transcript exists at the derived path", async () => {
    const s = await create({ name: "asid-1", cwd, trustWorkspace: true });
    sessions.push(s);
    expect(s.agentSessionId).toMatch(V4);
    createdId = s.agentSessionId as string;

    // One turn so claude persists the transcript, planting a token to recall.
    await s.send(`Remember this exact token for later: ${TOKEN}. Reply with just "ok".`);
    await s.wait({ timeoutMs: 90_000 });

    expect(existsSync(transcriptPath(cwd, createdId))).toBe(true);
  }, 180_000);

  it("resume rides extraArgs (--resume <id>) with no new code — the conversation continues", async () => {
    // Kill the first session so we don't drive one conversation from two panes,
    // then resume the SAME id in a fresh session (resume, NOT --session-id, so
    // no collision). The surfaced id is the resumed id (caller-wins).
    await sessions[0]?.kill().catch(() => undefined);

    const resumed = await create({
      name: "asid-resume",
      cwd,
      extraArgs: ["--resume", createdId],
      trustWorkspace: true,
    });
    sessions.push(resumed);
    expect(resumed.agentSessionId).toBe(createdId);

    await resumed.send("What exact token did I ask you to remember? Reply with only that token.");
    await resumed.wait({ timeoutMs: 90_000 });
    expect(await resumed.capture()).toContain(TOKEN);
  }, 180_000);

  it("a colliding create({ agentSessionId }) surfaces AgentExitedDuringBoot, fast (never a silent resume)", async () => {
    // createdId now has a persisted transcript → choosing it as a FRESH id
    // collides; claude exits, boot maps the reap to the typed error.
    const t0 = Date.now();
    const err = await create({
      name: "asid-collide",
      cwd,
      agentSessionId: createdId,
      trustWorkspace: true,
      bootTimeoutMs: 60_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentExitedDuringBoot);
    expect((err as AgentExitedDuringBoot).agentSessionId).toBe(createdId);
    // Fast — must not wait out the 60s ReplTimeout.
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 90_000);
});
