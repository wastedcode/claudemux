import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSocket } from "./default-backend.js";

/**
 * QA P2 (ce8bc31f): the socket-resolution gate must trim consistently —
 * gate and returned value agree — so a whitespace-padded socket name can't
 * silently diverge from its bare form and re-open the cross-process
 * rendezvous bug the P0 fix closed.
 */

describe("resolveSocket — precedence + trim consistency", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDEMUX_SOCKET;
    process.env.CLAUDEMUX_SOCKET = undefined;
    delete process.env.CLAUDEMUX_SOCKET;
  });

  afterEach(() => {
    process.env.CLAUDEMUX_SOCKET = savedEnv;
  });

  it("default when no flag and no env", () => {
    expect(resolveSocket()).toBe("claudemux");
  });

  it("env over default", () => {
    process.env.CLAUDEMUX_SOCKET = "from-env";
    expect(resolveSocket()).toBe("from-env");
  });

  it("explicit flag over env", () => {
    process.env.CLAUDEMUX_SOCKET = "from-env";
    expect(resolveSocket("from-flag")).toBe("from-flag");
  });

  it("a padded flag resolves to the same value as its trimmed form", () => {
    expect(resolveSocket("  my-sock  ")).toBe("my-sock");
    expect(resolveSocket("  my-sock  ")).toBe(resolveSocket("my-sock"));
  });

  it("a padded env value resolves to the same value as its trimmed form", () => {
    process.env.CLAUDEMUX_SOCKET = "  claudemux  ";
    // The whole bug: ' claudemux ' must resolve to the bare 'claudemux'
    // default so a later un-padded invocation finds the same server.
    expect(resolveSocket()).toBe("claudemux");
  });

  it("a whitespace-only flag is treated as 'not set' and falls through to env/default", () => {
    process.env.CLAUDEMUX_SOCKET = "env-sock";
    expect(resolveSocket("   ")).toBe("env-sock");
  });

  it("a whitespace-only env value falls through to the default", () => {
    process.env.CLAUDEMUX_SOCKET = "   ";
    expect(resolveSocket()).toBe("claudemux");
  });
});
