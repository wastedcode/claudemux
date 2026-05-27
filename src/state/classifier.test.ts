import { describe, expect, it } from "vitest";
import { classify } from "./classifier.js";
import type { ClassifierRules } from "./types.js";

const allTrue: ClassifierRules = {
  dialog: () => true,
  permissionPrompt: () => true,
  working: () => true,
  idle: () => true,
};

const allFalse: ClassifierRules = {
  dialog: () => false,
  permissionPrompt: () => false,
  working: () => false,
  idle: () => false,
};

const only = (key: keyof ClassifierRules): ClassifierRules => ({
  ...allFalse,
  [key]: () => true,
});

describe("classify — dispatch order", () => {
  it("returns 'dialog' when every predicate is true (dialog has highest priority)", () => {
    expect(classify("anything", allTrue)).toBe("dialog");
  });

  it("returns 'permission-prompt' when dialog is false but all others true", () => {
    expect(classify("anything", { ...allTrue, dialog: () => false })).toBe("permission-prompt");
  });

  it("returns 'working' when only dialog+permission-prompt are false", () => {
    expect(
      classify("anything", {
        ...allTrue,
        dialog: () => false,
        permissionPrompt: () => false,
      }),
    ).toBe("working");
  });

  it("returns 'idle' when only idle fires", () => {
    expect(classify("anything", only("idle"))).toBe("idle");
  });

  it("returns 'unknown' when no predicate fires (contractual 'no predicate fired')", () => {
    expect(classify("anything", allFalse)).toBe("unknown");
  });
});

describe("classify — each state reachable when only its predicate fires", () => {
  it.each([
    ["dialog", "dialog"],
    ["permissionPrompt", "permission-prompt"],
    ["working", "working"],
    ["idle", "idle"],
  ] as const)("only %s → %s", (key, state) => {
    expect(classify("x", only(key))).toBe(state);
  });
});

describe("classify — bottom-N scan invariant (caller pre-slices)", () => {
  it("classifier sees only the bottom-N text it is handed", () => {
    const fullPane = [
      ...Array.from({ length: 50 }, (_, i) => `line-${i}: ❯ should not match`),
      "thinking...",
    ].join("\n");
    const bottom = fullPane.split("\n").slice(-3).join("\n");
    const rules: ClassifierRules = {
      dialog: () => false,
      permissionPrompt: () => false,
      working: (t) => t.includes("thinking..."),
      idle: (t) => /\n❯ $/.test(t) || /^❯ $/.test(t),
    };
    expect(classify(bottom, rules)).toBe("working");
    expect(classify(fullPane, rules)).toBe("working");
  });
});
