import { describe, expect, it } from "vitest";
import type { Backend, BackendEvent, SendPayload, SessionRef } from "../../src/backends/types.js";
import { InvalidAgentSessionId, SessionExists } from "../../src/errors.js";
import { resume } from "../../src/session/resume.js";

/**
 * Hermetic `resume()` tests — peer of create-identity, no tmux / claude. A fake
 * backend serves a ready pane so boot settles (hooks off → pane path), and
 * records the spawned argv so we can assert resume maps the conversation id to
 * `--resume <id>` and surfaces it.
 */
const READY_PANE = ["──────", "❯ ", "──────", "  ⏵⏵ bypass permissions on"].join("\n");
const ID = "12345678-1234-4234-8234-123456789abc";

class RecordingBackend implements Backend {
  readonly id = "recording";
  spawnedArgv: string[] | undefined;
  readonly meta = new Map<string, string>();
  constructor(private readonly alreadyExists = false) {}
  spawn(o: SessionRef & { cmd: string; argv: string[] }): Promise<void> {
    this.spawnedArgv = o.argv;
    return Promise.resolve();
  }
  exists(_ref: SessionRef): Promise<boolean> {
    return Promise.resolve(this.alreadyExists);
  }
  kill(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve([]);
  }
  send(_ref: SessionRef, _p: SendPayload): Promise<void> {
    return Promise.resolve();
  }
  capture(_ref: SessionRef): Promise<string> {
    return Promise.resolve(READY_PANE);
  }
  setSessionMeta(_ref: SessionRef, k: string, v: string): Promise<void> {
    this.meta.set(k, v);
    return Promise.resolve();
  }
  getSessionMeta(_ref: SessionRef, k: string): Promise<string | undefined> {
    return Promise.resolve(this.meta.get(k));
  }
  onCommand(_h: (e: BackendEvent) => void): () => void {
    return () => undefined;
  }
}

describe("resume() — first-class lifecycle peer of create()", () => {
  it("injects `--resume <id>` and surfaces + caches that conversation id", async () => {
    const backend = new RecordingBackend();
    const s = await resume({
      name: "job-2",
      cwd: "/tmp",
      agentSessionId: ID,
      backend,
      bootTimeoutMs: 5_000,
      hooks: false,
    });
    expect(s.agentSessionId).toBe(ID);
    const argv = backend.spawnedArgv ?? [];
    const i = argv.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe(ID); // two adjacent elements
    expect(backend.meta.get("agent-session-id")).toBe(ID); // recoverable by adopt
  });

  it("rejects a malformed agentSessionId BEFORE spawn", async () => {
    const backend = new RecordingBackend();
    await expect(
      resume({ name: "bad", cwd: "/tmp", agentSessionId: "not-a-uuid", backend, hooks: false }),
    ).rejects.toThrow(InvalidAgentSessionId);
    expect(backend.spawnedArgv).toBeUndefined();
  });

  it("never silently adopts — a name that already exists throws SessionExists", async () => {
    const backend = new RecordingBackend(/* alreadyExists */ true);
    await expect(
      resume({ name: "taken", cwd: "/tmp", agentSessionId: ID, backend, hooks: false }),
    ).rejects.toThrow(SessionExists);
  });
});
