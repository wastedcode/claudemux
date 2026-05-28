import { describe, expect, it } from "vitest";
import { InvalidSessionName } from "../errors.js";
import { validateNamePart } from "./validate.js";

describe("validateNamePart", () => {
  describe("rejects empty strings", () => {
    it("name", () => {
      expect(() => validateNamePart("name", "")).toThrow(InvalidSessionName);
    });
    it("namespace", () => {
      expect(() => validateNamePart("namespace", "")).toThrow(InvalidSessionName);
    });
  });

  describe("rejects tmux-reserved characters", () => {
    const cases: { value: string; reason: string }[] = [
      { value: "has.dot", reason: "tmux parses session.window" },
      { value: "has:colon", reason: "tmux parses session:window" },
      { value: "has/slash", reason: "shell-quoting hazard" },
      { value: "has\\backslash", reason: "shell-quoting hazard" },
      { value: "has*star", reason: "tmux glob metachar" },
      { value: "has?question", reason: "tmux glob metachar" },
      { value: "has\nnewline", reason: "newline confuses argv" },
      { value: "has space", reason: "shell-quoting hazard" },
    ];
    for (const { value, reason } of cases) {
      it(`${JSON.stringify(value)} (${reason})`, () => {
        expect(() => validateNamePart("name", value)).toThrow(InvalidSessionName);
      });
    }
  });

  it("rejects leading dash", () => {
    expect(() => validateNamePart("name", "-flag-like")).toThrow(InvalidSessionName);
  });

  describe("accepts well-formed names", () => {
    const cases = ["a", "my-job", "my_job", "JOB-42", "agent-2026", "a-b-c-d-e"];
    for (const value of cases) {
      it(JSON.stringify(value), () => {
        expect(() => validateNamePart("name", value)).not.toThrow();
        expect(() => validateNamePart("namespace", value)).not.toThrow();
      });
    }
  });

  it("the thrown error carries field, value, and reason", () => {
    try {
      validateNamePart("name", "has.dot");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSessionName);
      const e = err as InvalidSessionName;
      expect(e.field).toBe("name");
      expect(e.value).toBe("has.dot");
      expect(e.message).toContain("has.dot");
      expect(e.message).toContain('"."');
    }
  });
});
