import { describe, expect, it } from "vitest";
import { defaultSocketName, mintSocket } from "./socket.js";

describe("defaultSocketName", () => {
  it("returns the literal 'claudemux' string", () => {
    expect(defaultSocketName()).toBe("claudemux");
  });

  it("is a pure function — no env reads, no side effects", () => {
    // Setting CLAUDEMUX_SOCKET in env must NOT affect this function. Env
    // composition is a bootstrap concern (default-backend.ts), not a
    // backend-leaf concern. Keeping this function pure preserves the
    // backend-tmux folder's testability without env mocking.
    const before = process.env.CLAUDEMUX_SOCKET;
    process.env.CLAUDEMUX_SOCKET = "should-be-ignored";
    try {
      expect(defaultSocketName()).toBe("claudemux");
    } finally {
      process.env.CLAUDEMUX_SOCKET = before;
    }
  });
});

describe("mintSocket", () => {
  it("returns names with the 'claudemux-' prefix", () => {
    const s = mintSocket();
    expect(s.startsWith("claudemux-")).toBe(true);
  });

  it("returns distinct names across calls (random per call)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(mintSocket());
    expect(seen.size).toBe(50);
  });
});
