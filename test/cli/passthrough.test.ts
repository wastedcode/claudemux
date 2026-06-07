import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/main.js";

/**
 * Parse-level regression: the two boot constructors (`spawn`, `resume`) must
 * BOTH accept the `-- <agent flags>` passthrough. The passthrough once lived
 * only on `spawn` while `resume` silently dropped it; this locks the symmetry
 * at the command-definition layer (no boot, no backend).
 */
describe("CLI — boot verbs share the `-- <agent flags>` passthrough", () => {
  const program = buildProgram();
  const cmd = (name: string) => {
    const found = program.commands.find((c) => c.name() === name);
    if (found === undefined) throw new Error(`command ${name} not registered`);
    return found;
  };

  for (const verb of ["spawn", "resume"] as const) {
    it(`${verb} ends in a variadic that captures post-\`--\` agent flags`, () => {
      const args = cmd(verb).registeredArguments;
      const last = args.at(-1);
      expect(last?.name()).toBe("claudeArgs");
      expect(last?.variadic).toBe(true);
    });

    it(`${verb} declares --cwd, --boot-timeout-ms and --trust-workspace`, () => {
      const flags = cmd(verb).options.map((o) => o.long);
      expect(flags).toEqual(
        expect.arrayContaining(["--cwd", "--boot-timeout-ms", "--trust-workspace"]),
      );
    });
  }
});
