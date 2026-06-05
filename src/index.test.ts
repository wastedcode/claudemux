import { describe, expect, it } from "vitest";
import * as publicSurface from "./index.js";

/**
 * Public-surface smoke test. The exact symbol list is locked at v0.0.1 —
 * adding or removing anything here is a breaking change.
 */

describe("public surface — exports", () => {
  it("exports the four verb functions", () => {
    expect(typeof publicSurface.create).toBe("function");
    expect(typeof publicSurface.exists).toBe("function");
    expect(typeof publicSurface.kill).toBe("function");
    expect(typeof publicSurface.list).toBe("function");
  });

  it("exports the claude AgentDef", () => {
    expect(publicSurface.claude).toBeDefined();
    expect(publicSurface.claude.name).toBe("claude");
  });

  it("exports the typed errors plus the base class", () => {
    const expected = [
      "ClaudemuxError",
      "SessionExists",
      "DialogStuck",
      "ReplTimeout",
      "LoginRequired",
      "SessionGone",
      "BackendUnreachable",
      "BackendError",
      "InvalidSessionName",
      "WorkspaceUntrusted",
    ] as const;
    for (const name of expected) {
      expect(typeof (publicSurface as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("does NOT export the internal seam types (Backend / SendPayload / etc.)", () => {
    const internalSeamNames = [
      "Backend",
      "BackendEvent",
      "SendPayload",
      "ClassifierRules",
      "Mutex",
      "Emitter",
      "TmuxExec",
      "tmuxBackend",
    ];
    for (const name of internalSeamNames) {
      expect((publicSurface as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
