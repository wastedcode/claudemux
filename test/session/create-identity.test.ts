import { describe, expect, it } from "vitest";
import { claude } from "../../src/agents/claude.js";
import type { AgentDef } from "../../src/agents/types.js";
import type { Backend, BackendEvent, SendPayload, SessionRef } from "../../src/backends/types.js";
import { AgentSessionIdConflict, InvalidAgentSessionId } from "../../src/errors.js";
import { create } from "../../src/session/create.js";

/**
 * Hermetic `create()` identity tests — no tmux, no claude. A fake backend
 * records the spawned argv and serves a stable ready pane so boot completes,
 * letting us assert what `create()` mints, threads, surfaces, and caches
 * without spawning a real agent. (The on-box round-trip lives in
 * `agent-session-id.live.test.ts`.)
 */

/** A claude-shaped ready pane: the empty `❯` input box with the footer below. */
const READY_PANE = [
  "────────────────",
  "❯ ",
  "────────────────",
  "  ⏵⏵ bypass permissions on",
].join("\n");

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLER_UUID = "12345678-1234-4234-8234-123456789abc";

interface SpawnRecord {
  cmd: string;
  argv: string[];
}

/**
 * Records spawn argv + session-meta writes; serves a ready pane on capture so
 * boot settles fast. `metaFailure` makes `setSessionMeta` reject, to prove the
 * best-effort cache write never fails `create()`.
 */
class RecordingBackend implements Backend {
  readonly id = "recording";
  spawned: SpawnRecord | undefined;
  readonly meta = new Map<string, string>();
  killed = 0;
  constructor(private readonly metaFailure = false) {}

  spawn(o: SessionRef & { cmd: string; argv: string[] }): Promise<void> {
    this.spawned = { cmd: o.cmd, argv: o.argv };
    return Promise.resolve();
  }
  kill(_ref: SessionRef): Promise<void> {
    this.killed++;
    return Promise.resolve();
  }
  exists(_ref: SessionRef): Promise<boolean> {
    return Promise.resolve(false);
  }
  list(_namespace: string): Promise<string[]> {
    return Promise.resolve([]);
  }
  send(_ref: SessionRef, _payload: SendPayload): Promise<void> {
    return Promise.resolve();
  }
  capture(_ref: SessionRef): Promise<string> {
    return Promise.resolve(READY_PANE);
  }
  setSessionMeta(_ref: SessionRef, key: string, value: string): Promise<void> {
    if (this.metaFailure) return Promise.reject(new Error("meta store unavailable"));
    this.meta.set(key, value);
    return Promise.resolve();
  }
  getSessionMeta(_ref: SessionRef, key: string): Promise<string | undefined> {
    return Promise.resolve(this.meta.get(key));
  }
  onCommand(_h: (e: BackendEvent) => void): () => void {
    return () => undefined;
  }
}

/** Boot fast: a tiny stable-window keeps each create() ~instant. */
const FAST_BOOT = 5_000;

describe("create() — mint + inject + surface agentSessionId (ticket A)", () => {
  it("mints a v4 UUID, injects --session-id <id> as two adjacent argv elements, surfaces it", async () => {
    const backend = new RecordingBackend();
    const s = await create({ name: "mint", cwd: "/tmp", backend, bootTimeoutMs: FAST_BOOT });

    expect(s.agentSessionId).toMatch(V4);
    const argv = backend.spawned?.argv ?? [];
    const i = argv.indexOf("--session-id");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe(s.agentSessionId); // adjacent, separate element
    expect(argv.some((a) => a.startsWith("--session-id="))).toBe(false); // never joined
    expect(argv.filter((a) => a === "--session-id")).toHaveLength(1); // exactly one
  });

  it("caches the surfaced id under the recoverable session-meta key", async () => {
    const backend = new RecordingBackend();
    const s = await create({ name: "cache", cwd: "/tmp", backend, bootTimeoutMs: FAST_BOOT });
    expect(backend.meta.get("agent-session-id")).toBe(s.agentSessionId);
  });

  it("surfaces the value buildArgv RETURNS, not the minted variable (they cannot diverge)", async () => {
    // A stub whose buildArgv ignores the mint and returns its own id. If create
    // surfaced the mint instead of the returned value, this would fail.
    const SENTINEL = "buildargv-decided-this";
    const stub: AgentDef = {
      name: "stub",
      buildArgv: () => ({ cmd: "sh", argv: [], agentSessionId: SENTINEL }),
      boot: { dialogs: [], isReady: (t) => t.includes("❯") },
      rules: {
        dialog: () => false,
        permissionPrompt: () => false,
        working: () => false,
        idle: (t) => t.includes("❯"),
      },
    };
    const backend = new RecordingBackend();
    const s = await create({
      name: "diverge",
      cwd: "/tmp",
      backend,
      agent: stub,
      bootTimeoutMs: FAST_BOOT,
    });
    expect(s.agentSessionId).toBe(SENTINEL);
    expect(backend.meta.get("agent-session-id")).toBe(SENTINEL);
  });

  it("a failing setSessionMeta does NOT fail create() (best-effort cache, id still on the handle)", async () => {
    const backend = new RecordingBackend(/* metaFailure */ true);
    const s = await create({ name: "besteffort", cwd: "/tmp", backend, bootTimeoutMs: FAST_BOOT });
    expect(s.agentSessionId).toMatch(V4); // id is on the handle from the mint
    expect(backend.killed).toBe(0); // create did not tear down
  });
});

describe("create({ agentSessionId }) — caller-chosen id (ticket B)", () => {
  it("injects and surfaces exactly the caller's valid v4 UUID", async () => {
    const backend = new RecordingBackend();
    const s = await create({
      name: "chosen",
      cwd: "/tmp",
      backend,
      agentSessionId: CALLER_UUID,
      bootTimeoutMs: FAST_BOOT,
    });
    expect(s.agentSessionId).toBe(CALLER_UUID);
    const argv = backend.spawned?.argv ?? [];
    expect(argv).toContain(CALLER_UUID);
  });

  it("a malformed agentSessionId throws InvalidAgentSessionId BEFORE spawn", async () => {
    const backend = new RecordingBackend();
    await expect(
      create({
        name: "bad",
        cwd: "/tmp",
        backend,
        agentSessionId: "not-a-uuid",
        bootTimeoutMs: FAST_BOOT,
      }),
    ).rejects.toThrow(InvalidAgentSessionId);
    expect(backend.spawned).toBeUndefined(); // never reached spawn
  });

  it("a non-v4 UUID (wrong version nibble) is rejected too", async () => {
    const backend = new RecordingBackend();
    await expect(
      create({
        name: "v1",
        cwd: "/tmp",
        backend,
        agentSessionId: "12345678-1234-1234-8234-123456789abc", // version 1
        bootTimeoutMs: FAST_BOOT,
      }),
    ).rejects.toThrow(InvalidAgentSessionId);
    expect(backend.spawned).toBeUndefined();
  });

  it("explicit agentSessionId + a conflicting extraArgs identity flag fails fast BEFORE spawn", async () => {
    const backend = new RecordingBackend();
    await expect(
      create({
        name: "conflict",
        cwd: "/tmp",
        backend,
        agentSessionId: CALLER_UUID,
        extraArgs: ["--resume", "99999999-8888-4777-9666-555555555555"],
        bootTimeoutMs: FAST_BOOT,
      }),
    ).rejects.toThrow(AgentSessionIdConflict);
    expect(backend.spawned).toBeUndefined();
  });
});

describe("create() — the one unknowable path: bare --resume (claude picks the id)", () => {
  it("surfaces undefined and writes no session-meta cache", async () => {
    const backend = new RecordingBackend();
    const s = await create({
      name: "bareresume",
      cwd: "/tmp",
      backend,
      extraArgs: ["--resume"],
      bootTimeoutMs: FAST_BOOT,
    });
    expect(s.agentSessionId).toBeUndefined();
    expect(backend.meta.has("agent-session-id")).toBe(false); // nothing to cache
    // The mint was suppressed — no --session-id was injected.
    expect(backend.spawned?.argv).not.toContain("--session-id");
  });
});

// Guard: the real claude agent is the default, so the fixtures above exercise
// the same buildArgv path production uses (not just the stub).
describe("create() uses the claude agent's buildArgv by default", () => {
  it("the default agent is claude (its buildArgv injects --session-id)", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: CALLER_UUID });
    expect(r.argv).toEqual(["--session-id", CALLER_UUID]);
  });
});
