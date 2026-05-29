import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { create } from "../../src/session/create.js";
import type { SessionHandle } from "../../src/types.js";

/**
 * Live `interrupt()` behavior against a REAL authenticated claude — the cases
 * that can only be proven by interrupting a genuinely-working agent. The
 * mutex/ordering invariant (case 3) is covered offline in `interrupt.test.ts`;
 * this file covers acceptance cases 1, 2, and 4.
 *
 * Like `permission-prompts.test.ts`, this spawns a real claude, so it is
 * **excluded from the gate suite** (see `vitest.config.ts`) and only runs when
 * `CLAUDEMUX_LIVE_INTERRUPT=1` AND a network-isolated, authenticated claude is
 * present. It self-skips cleanly otherwise.
 *
 * Empirical baseline (run 2026-05-29, dogfood box): interrupt() on a working
 * agent returned in ~293ms (250ms settle); a following state() reads a
 * non-working frame (`unknown` — claude restores the interrupted prompt into the
 * composer) with the `"esc to interrupt"` affordance gone. interrupt() on an
 * idle agent leaves state at `idle`. These tests encode that.
 */
const LIVE = process.env.CLAUDEMUX_LIVE_INTERRUPT === "1";

/** Poll the handle's state until `working` (the agent has actually started). */
async function waitUntilWorking(s: SessionHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await s.state()) === "working") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("agent never reached working state within budget");
}

const LONG_TASK =
  "Slowly write a detailed 600-word essay about the history of the typewriter. " +
  "Think carefully paragraph by paragraph before writing each one.";

describe("interrupt() — live behavior", () => {
  if (!LIVE) {
    it.skip("auth-gated — set CLAUDEMUX_LIVE_INTERRUPT=1 under the network-isolated live workflow to enable", () => {});
    return;
  }

  let cwd: string;
  let session: SessionHandle;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "claudemux-interrupt-live-"));
    session = await create({ name: "interrupt-live", cwd, trustWorkspace: true });
  }, 90_000);

  afterAll(async () => {
    await session?.kill();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  // Case 2 runs first: a freshly-`create()`d session is idle, the cleanest
  // precondition for the idle-harmless check (cases 1/4 leave the agent in the
  // post-interrupt `unknown` frame).
  it("case 2 — interrupt() on an idle agent is harmless (no throw, stays idle)", async () => {
    expect(await session.state()).toBe("idle");

    await expect(session.interrupt()).resolves.toBeUndefined();

    expect(await session.state()).toBe("idle");
    expect(await session.capture()).not.toContain("esc to interrupt");
  }, 60_000);

  it("case 1 — interrupt() on a working agent leaves the affordance; state() no longer working", async () => {
    await session.send(LONG_TASK);
    await waitUntilWorking(session);
    expect(await session.capture()).toContain("esc to interrupt");

    await session.interrupt();

    // The fixed post-interrupt settle is what makes this immediate read hold.
    // State reads `unknown` (the interrupted frame) — the assertion is only
    // that it is no longer `working` and the affordance is gone.
    expect(await session.state()).not.toBe("working");
    expect(await session.capture()).not.toContain("esc to interrupt");
  }, 120_000);

  it("case 4 — clean interrupt-and-replace: stop, clear the restored composer to empty, then send (claude-specific recipe)", async () => {
    // Distinctive token in the original task so we can prove the replacement
    // turn ran and the original did NOT re-run from a dirty composer.
    await session.send(
      "Slowly write a 600-word essay about the history of the ASTROLABE_TOPIC_8812, paragraph by paragraph.",
    );
    await waitUntilWorking(session);

    // ESC #1 stops the turn — but claude restores the old prompt into the
    // composer, so a naive send() would concatenate. Clear by OBSERVING the
    // composer empty (the original token gone), not by a blind ESC count.
    await session.interrupt();
    for (let i = 0; i < 4 && (await session.capture()).includes("ASTROLABE_TOPIC_8812"); i++) {
      await session.interrupt();
    }
    expect(await session.capture()).not.toContain("ASTROLABE_TOPIC_8812");

    const marker = "REDIRECT_MARKER_4421";
    await session.send(`Reply with exactly: ${marker} and nothing else.`);
    await session.wait({ timeoutMs: 60_000 });

    const final = await session.capture();
    expect(final).toContain(marker);
    // The replacement was clean — the interrupted essay did not resurface.
    expect(final).not.toContain("ASTROLABE_TOPIC_8812");
  }, 180_000);
});
