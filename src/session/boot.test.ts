import { describe, expect, it } from "vitest";
import type { AgentDef, BootDialog } from "../agents/types.js";
import type { Backend, BackendEvent, SendPayload, SessionRef } from "../backends/types.js";
import { DialogStuck, LoginRequired, ReplTimeout, WorkspaceUntrusted } from "../errors.js";
import { bootSession } from "./boot.js";

/**
 * Scriptable fake backend for hermetic boot tests. The pane content evolves
 * across a list of stages; each stage is advanced when the substrate
 * `send`s a payload (so we can prove dialog responses propagate through
 * the boot loop).
 */
class FakeBackend implements Backend {
  readonly id = "fake";
  private stages: string[];
  private stageIdx = 0;
  readonly sent: SendPayload[] = [];

  constructor(stages: string[]) {
    this.stages = stages;
  }

  private peek(): string {
    return this.stages[Math.min(this.stageIdx, this.stages.length - 1)] ?? "";
  }

  spawn(): Promise<void> {
    return Promise.resolve();
  }
  kill(_ref: SessionRef): Promise<void> {
    return Promise.resolve();
  }
  exists(_ref: SessionRef): Promise<boolean> {
    return Promise.resolve(true);
  }
  list(_namespace: string): Promise<string[]> {
    return Promise.resolve([]);
  }
  send(_ref: SessionRef, payload: SendPayload): Promise<void> {
    this.sent.push(payload);
    // Advance to the next stage on each send (paste-and-Enter both count;
    // boot's response loop sends one key per dialog response in tests).
    this.stageIdx = Math.min(this.stageIdx + 1, this.stages.length - 1);
    return Promise.resolve();
  }
  capture(_ref: SessionRef): Promise<string> {
    return Promise.resolve(this.peek());
  }
  onCommand(_h: (e: BackendEvent) => void): () => void {
    return () => undefined;
  }
}

/** Minimal AgentDef stub — boot.ts only touches `boot.dialogs` and `boot.isReady`. */
function stubAgent(dialogs: AgentDef["boot"]["dialogs"]): AgentDef {
  const isReady = (text: string) => text.trim().endsWith("READY");
  return {
    name: "fake",
    buildArgv: () => ({ cmd: "fake", argv: [] }),
    boot: { dialogs, isReady },
    rules: {
      dialog: (t) => dialogs.some((d) => d.matches(t)),
      permissionPrompt: () => false,
      working: () => false,
      idle: isReady,
    },
  };
}

describe("bootSession — happy paths", () => {
  it("returns when isReady fires and no dialog has matched", async () => {
    const fb = new FakeBackend(["READY"]);
    const agent = stubAgent([]);
    await expect(
      bootSession(fb, agent, { namespace: "ns", name: "tgt" }, { timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
    expect(fb.sent).toEqual([]); // no dialogs touched
  });

  it("dismisses a theme-picker-shaped dialog with Enter, then reads ready", async () => {
    const fb = new FakeBackend(["DIALOG_THEME", "READY"]);
    const agent = stubAgent([
      {
        id: "theme",
        matches: (t) => t.includes("DIALOG_THEME"),
        respond: { kind: "key", key: "Enter" },
      },
    ]);
    await bootSession(fb, agent, { namespace: "ns", name: "tgt" }, { timeoutMs: 5_000 });
    expect(fb.sent).toEqual([{ kind: "key", key: "Enter" }]);
  });

  it("sends Enter follow-up after a numeric/letter dialog response", async () => {
    const fb = new FakeBackend(["DIALOG_TRUST", "READY"]);
    const agent = stubAgent([
      {
        id: "trust",
        matches: (t) => t.includes("DIALOG_TRUST"),
        respond: { kind: "key", key: "1" },
      },
    ]);
    await bootSession(fb, agent, { namespace: "ns", name: "tgt" }, { timeoutMs: 5_000 });
    expect(fb.sent).toEqual([
      { kind: "key", key: "1" },
      { kind: "key", key: "Enter" },
    ]);
  });
});

describe("bootSession — error paths", () => {
  it("throws LoginRequired when a throw-class dialog fires", async () => {
    const fb = new FakeBackend(["DIALOG_LOGIN", "READY"]);
    const agent = stubAgent([
      {
        id: "login-method",
        matches: (t) => t.includes("DIALOG_LOGIN"),
        respond: { kind: "throw", errorClass: "LoginRequired" },
      },
    ]);
    await expect(
      bootSession(fb, agent, { namespace: "ns", name: "sess" }, { timeoutMs: 5_000 }),
    ).rejects.toThrow(LoginRequired);
  });

  it("throws DialogStuck when a recognized dialog persists past the response", async () => {
    // Stage stays on the dialog forever — the response never advances the pane.
    const fb = new FakeBackend(["DIALOG_STUCK"]);
    const agent = stubAgent([
      {
        id: "stuck",
        matches: (t) => t.includes("DIALOG_STUCK"),
        respond: { kind: "key", key: "Enter" },
      },
    ]);
    // Set boot timeout > dialog-advance budget so DialogStuck (not ReplTimeout) fires.
    const err = await bootSession(
      fb,
      agent,
      { namespace: "ns", name: "sess" },
      { timeoutMs: 30_000 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DialogStuck);
    expect((err as DialogStuck).dialogId).toBe("stuck");
  });

  it("throws ReplTimeout when the pane never reaches a dialog or ready state", async () => {
    const fb = new FakeBackend(["random output that matches nothing"]);
    const agent = stubAgent([]);
    await expect(
      bootSession(fb, agent, { namespace: "ns", name: "sess" }, { timeoutMs: 500 }),
    ).rejects.toThrow(ReplTimeout);
  });
});

describe("bootSession — workspace-trust gate (fail closed)", () => {
  const trustDialog: BootDialog = {
    id: "workspace-trust",
    matches: (t) => t.includes("DIALOG_TRUST"),
    respond: { kind: "key", key: "1" },
    gate: { option: "trustWorkspace", errorClass: "WorkspaceUntrusted" },
  };

  it("throws WorkspaceUntrusted and sends NO keystroke when trustWorkspace is unset", async () => {
    const fb = new FakeBackend(["DIALOG_TRUST", "READY"]);
    const agent = stubAgent([trustDialog]);
    const err = await bootSession(
      fb,
      agent,
      { namespace: "ns", name: "job" },
      { cwd: "/work" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceUntrusted);
    // The load-bearing invariant: NO key was sent (a key would write the
    // persistent trust flag before we could refuse).
    expect(fb.sent).toEqual([]);
    expect((err as WorkspaceUntrusted).cwd).toBe("/work");
  });

  it("dismisses the trust dialog (1 + Enter) and reaches ready when trustWorkspace is true", async () => {
    const fb = new FakeBackend(["DIALOG_TRUST", "READY"]);
    const agent = stubAgent([trustDialog]);
    await bootSession(
      fb,
      agent,
      { namespace: "ns", name: "job" },
      { cwd: "/work", trustWorkspace: true, timeoutMs: 10_000 },
    );
    expect(fb.sent).toEqual([
      { kind: "key", key: "1" },
      { kind: "key", key: "Enter" },
    ]);
  });
});

describe("bootSession — premature-ready guard (stabilize gate)", () => {
  it("does NOT return on a transient ready that immediately changes (welcome/MCP render)", async () => {
    // Frame 0 looks ready ("…READY"), but the very next capture changes to a
    // working-shaped frame and only later settles back to ready. A
    // snapshot-boot would return on frame 0 (premature); the stabilize gate
    // must wait for the pane to hold steady.
    let calls = 0;
    const flapThenSettle: Backend = {
      id: "flap",
      spawn: () => Promise.resolve(),
      kill: () => Promise.resolve(),
      exists: () => Promise.resolve(true),
      list: () => Promise.resolve([]),
      send: () => Promise.resolve(),
      capture: () => {
        calls++;
        // First few captures flap (rendering); then settle to a stable ready.
        return Promise.resolve(calls < 4 ? `render-${calls} READY` : "settled READY");
      },
      onCommand: () => () => undefined,
    };
    const agent = stubAgent([]);
    await bootSession(flapThenSettle, agent, { namespace: "ns", name: "x" }, { timeoutMs: 10_000 });
    // It must have polled past the flapping frames before declaring ready.
    expect(calls).toBeGreaterThan(4);
  });
});

describe("bootSession — multi-dialog ordering", () => {
  it("dialogs fire in order; first match wins", async () => {
    const fb = new FakeBackend(["A_THEN_B", "B_ONLY", "READY"]);
    const agent = stubAgent([
      { id: "a", matches: (t) => t.includes("A_"), respond: { kind: "key", key: "Enter" } },
      { id: "b", matches: (t) => t.includes("B_"), respond: { kind: "key", key: "Enter" } },
    ]);
    await bootSession(fb, agent, { namespace: "ns", name: "tgt" }, { timeoutMs: 5_000 });
    // Two Enter sends (one for "a", one for "b").
    expect(fb.sent).toEqual([
      { kind: "key", key: "Enter" },
      { kind: "key", key: "Enter" },
    ]);
  });
});
