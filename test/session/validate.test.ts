import { describe, expect, it } from "vitest";
import { ClaudemuxError, InvalidEnvVarName } from "../../src/errors.js";
import { validateEnvVarName } from "../../src/session/validate.js";

/**
 * Boundary validation of `unsetEnv` names (ADR 0008 follow-up). The allow-list
 * shape (`[A-Za-z_][A-Za-z0-9_]*`) is the point — it keeps a name `env` cannot
 * misparse regardless of producer.
 */
describe("validateEnvVarName", () => {
  // Regression guard for the real producer: every NESTED_AGENT_ENV name in
  // src/agents/claude.ts must validate, or we'd break the trusted nested-agent
  // launch path.
  it.each([
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "AI_AGENT",
  ])("accepts the NESTED_AGENT_ENV name %s", (name) => {
    expect(() => validateEnvVarName(name)).not.toThrow();
  });

  it.each(["_FOO", "X"])("accepts the identifier-shaped name %s", (name) => {
    expect(() => validateEnvVarName(name)).not.toThrow();
  });

  it.each(["", "-X", "A=B", "A B", "A.B", "1ABC", "A\nB", "A\0B"])(
    "rejects the malformed name %j with InvalidEnvVarName",
    (name) => {
      expect(() => validateEnvVarName(name)).toThrow(InvalidEnvVarName);
    },
  );

  it("carries the offending input on .value and is a ClaudemuxError", () => {
    for (const bad of ["", "-X", "A=B", "A B", "A.B", "1ABC", "A\nB", "A\0B"]) {
      let caught: unknown;
      try {
        validateEnvVarName(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidEnvVarName);
      expect(caught).toBeInstanceOf(ClaudemuxError);
      expect((caught as InvalidEnvVarName).value).toBe(bad);
    }
  });
});
