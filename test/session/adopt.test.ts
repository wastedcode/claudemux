import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDef } from "../../src/agents/types.js";
import { tmuxBackend } from "../../src/backends/tmux/index.js";
import type { Backend, SessionRef } from "../../src/backends/types.js";
import { InvalidSessionName, SessionGone } from "../../src/errors.js";
import { adopt } from "../../src/session/adopt.js";
import { Harness } from "../harness/index.js";

let h: Harness;

beforeEach(() => {
  h = Harness.create();
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

const NS = "claudemux";

/**
 * Spawn a long-lived pane that prints a known marker then sleeps, so the
 * adopted pane has deterministic content the classifier/capture can read.
 * No `claude` involved — these tests exercise `adopt()`'s attach contract,
 * not the real boot path (that's create.test.ts's auth-gated job).
 *
 * The marker is anchored at the BOTTOM of the visible region (a screenful of
 * leading newlines scrolls it down). The classifier scans only the bottom-N
 * lines — exactly where a real agent's ready marker lives — so a fixture that
 * printed the marker at the top would fall outside that window. This mirrors
 * where the signal actually sits, it isn't a workaround.
 */
async function spawnLive(backend: Backend, name: string, marker = "ROUNDTRIP_OK"): Promise<void> {
  await backend.spawn({
    namespace: NS,
    name,
    cwd: h.sandbox.home,
    cmd: "sh",
    argv: ["-c", `for i in $(seq 50); do echo; done; echo ${marker}; sleep 60`],
  });
}

/**
 * Wrap a backend, counting the calls `adopt()` is allowed (and not allowed)
 * to make. Used to prove the pure-attach contract (#3) and the
 * validate-before-exists ordering (#5) without coupling to tmux argv.
 */
function countingBackend(inner: Backend): { backend: Backend; counts: Record<string, number> } {
  const counts = { exists: 0, spawn: 0, send: 0, kill: 0, capture: 0 };
  const backend: Backend = {
    id: inner.id,
    spawn: (o) => {
      counts.spawn++;
      return inner.spawn(o);
    },
    kill: (ref) => {
      counts.kill++;
      return inner.kill(ref);
    },
    exists: (ref) => {
      counts.exists++;
      return inner.exists(ref);
    },
    list: (ns) => inner.list(ns),
    send: (ref, payload) => {
      counts.send++;
      return inner.send(ref, payload);
    },
    capture: (ref, o) => {
      counts.capture++;
      return inner.capture(ref, o);
    },
    setSessionMeta: (ref, key, value) => inner.setSessionMeta(ref, key, value),
    getSessionMeta: (ref, key) => inner.getSessionMeta(ref, key),
    onCommand: (handler) => inner.onCommand(handler),
  };
  return { backend, counts };
}

/**
 * Minimal stub agent whose only idle signal is a unique marker. Proves the
 * classifier reads the PASSED agent's `rules`, not the session's or claude's.
 * `buildArgv`/`boot` are never reached by adopt (pure attach) — present only
 * to satisfy the AgentDef type.
 */
const STUB_MARKER = "STUB_IDLE_MARKER";
const stubAgent: AgentDef = {
  name: "stub",
  buildArgv: () => ({ cmd: "sh", argv: [] }),
  boot: { dialogs: [], isReady: () => false },
  rules: {
    dialog: () => false,
    permissionPrompt: () => false,
    working: () => false,
    idle: (text) => text.includes(STUB_MARKER),
  },
};

describe("adopt() — #1 round-trip against a live pane", () => {
  it("returns a working handle (send / state / capture round-trip)", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await spawnLive(backend, "rt");

    const session = await adopt({ name: "rt", backend });

    // capture reads the live pane we attached to (poll: the echo lands a beat
    // after spawn, so a bare capture would race the shell's first write).
    await expect.poll(() => session.capture()).toContain("ROUNDTRIP_OK");
    // state classifies the live pane without throwing
    await expect(session.state()).resolves.toBeTypeOf("string");
    // send delivers a turn without throwing, returning a cursor anchor
    await expect(session.send("noop")).resolves.toBeTypeOf("string");

    await backend.kill({ namespace: NS, name: "rt" });
  });
});

describe("adopt() — #2 absence", () => {
  it("throws SessionGone for a session that was never created", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await expect(adopt({ name: "ghost", backend })).rejects.toThrow(SessionGone);
  });
});

describe("adopt() — #3 pure attach", () => {
  it("creates no new pane and sends no boot keystrokes", async () => {
    const real = tmuxBackend({ socket: h.socket });
    await spawnLive(real, "attach");

    const before = await real.list(NS);
    const { backend, counts } = countingBackend(real);

    await adopt({ name: "attach", backend });

    // No spawn, no send (no boot) during adopt itself.
    expect(counts.spawn).toBe(0);
    expect(counts.send).toBe(0);
    // Session count unchanged — adopt added no pane.
    const after = await real.list(NS);
    expect(after.sort()).toEqual(before.sort());

    await real.kill({ namespace: NS, name: "attach" });
  });
});

describe("adopt() — #4 restart round-trip (the dogfood falsifier)", () => {
  it("a genuinely separate backend instance re-adopts a prior instance's session", async () => {
    // Instance A creates the session (the pre-restart daemon).
    const backendA = tmuxBackend({ socket: h.socket });
    await spawnLive(backendA, "survivor");

    // Instance B is a fresh backend object over the SAME socket (the daemon
    // after restart — new process, same rendezvous, sessions still live).
    const backendB = tmuxBackend({ socket: h.socket });
    expect(backendB).not.toBe(backendA);

    const session = await adopt({ name: "survivor", backend: backendB });
    await expect.poll(() => session.capture()).toContain("ROUNDTRIP_OK");
    await expect(session.state()).resolves.toBeTypeOf("string");

    await backendB.kill({ namespace: NS, name: "survivor" });
  });
});

describe("adopt() — #5 idempotent + input guard", () => {
  it("is safe to repeat — two adopts of the same live session both work", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await spawnLive(backend, "twice");

    const before = await backend.list(NS);
    const s1 = await adopt({ name: "twice", backend });
    const s2 = await adopt({ name: "twice", backend });

    // Both handles are live and independent; no double-spawn.
    await expect.poll(() => s1.capture()).toContain("ROUNDTRIP_OK");
    await expect.poll(() => s2.capture()).toContain("ROUNDTRIP_OK");
    const after = await backend.list(NS);
    expect(after.sort()).toEqual(before.sort());

    await backend.kill({ namespace: NS, name: "twice" });
  });

  it("rejects an invalid name with InvalidSessionName BEFORE calling exists()", async () => {
    const { backend, counts } = countingBackend(tmuxBackend({ socket: h.socket }));

    await expect(adopt({ name: "bad.name", backend })).rejects.toThrow(InvalidSessionName);
    // Validation must run before the exists-check — the backend was never probed.
    expect(counts.exists).toBe(0);

    // Namespace is validated too (mirrors create()), also before exists().
    await expect(adopt({ name: "ok", namespace: "bad:ns", backend })).rejects.toThrow(
      InvalidSessionName,
    );
    expect(counts.exists).toBe(0);
  });
});

describe("adopt() — #7 agentSessionId recovery from the session-meta cache", () => {
  const ID = "abcdef01-2345-4678-9abc-def012345678";

  it("recovers the id create() cached on the live session", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await spawnLive(backend, "recover");
    // Simulate what create() does after spawn: cache the id under the shared key.
    await backend.setSessionMeta({ namespace: NS, name: "recover" }, "agent-session-id", ID);

    const session = await adopt({ name: "recover", backend });
    expect(session.agentSessionId).toBe(ID);

    await backend.kill({ namespace: NS, name: "recover" });
  });

  it("reports undefined on a cache miss — never fabricates an id", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await spawnLive(backend, "nocache"); // no meta written

    const session = await adopt({ name: "nocache", backend });
    expect(session.agentSessionId).toBeUndefined();

    await backend.kill({ namespace: NS, name: "nocache" });
  });
});

describe("adopt() — #6 agent-def fidelity", () => {
  it("classifies via the PASSED agent's rules, not the session or claude", async () => {
    const backend = tmuxBackend({ socket: h.socket });
    await spawnLive(backend, "classify", STUB_MARKER);

    const ref: SessionRef = { namespace: NS, name: "classify" };
    // Wait for the marker to land on the pane before classifying.
    await expect.poll(() => backend.capture(ref)).toContain(STUB_MARKER);

    // The stub's only idle signal is STUB_MARKER → state() reports "idle".
    const stubSession = await adopt({ name: "classify", backend, agent: stubAgent });
    await expect(stubSession.state()).resolves.toBe("idle");

    // The default (claude) agent sees no ❯ box / no spinner on that same pane
    // → "unknown". Same pane, different verdict = classification follows the
    // passed agent, proving the silent-misclassification footgun is real.
    const claudeSession = await adopt({ name: "classify", backend });
    await expect(claudeSession.state()).resolves.toBe("unknown");

    await backend.kill(ref);
  });
});
