import { describe, expect, it } from "vitest";
import { claude } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import { buildHookInjection, rendezvousPathFor } from "./hooks.js";

const ID = "f3aaa87f-d2e3-4fea-89bf-80cda78d5f22";

describe("rendezvousPathFor", () => {
  it("is a local .ndjson under the state dir, keyed by session id", () => {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/state-x";
    try {
      expect(rendezvousPathFor(ID)).toBe(`/tmp/state-x/claudemux/turns/${ID}.ndjson`);
    } finally {
      // biome-ignore lint/performance/noDelete: env cleanup needs `delete` — `= undefined` sets the string "undefined" in Node.
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });
});

describe("buildHookInjection", () => {
  it("default-on with a hook-capable agent → injects the agent's flag + rendezvous path", () => {
    const r = buildHookInjection({
      agent: claude,
      sessionId: ID,
      enabled: true,
      userExtraArgs: [],
    });
    expect(r.rendezvousPath).toContain(`claudemux/turns/${ID}.ndjson`);
    expect(r.args[0]).toBe("--settings");
    // The injected settings target exactly our rendezvous path.
    expect(r.args[1]).toContain(`${ID}.ndjson`);
  });

  it("opt-out (enabled:false) → no injection, no rendezvous", () => {
    const r = buildHookInjection({
      agent: claude,
      sessionId: ID,
      enabled: false,
      userExtraArgs: [],
    });
    expect(r.args).toEqual([]);
    expect(r.rendezvousPath).toBeUndefined();
  });

  it("an agent without hooks → no injection", () => {
    // Construct an AgentDef that simply omits the optional `hooks` field.
    const noHooks: AgentDef = {
      name: claude.name,
      buildArgv: claude.buildArgv,
      boot: claude.boot,
      rules: claude.rules,
      ...(claude.transcript ? { transcript: claude.transcript } : {}),
    };
    const r = buildHookInjection({
      agent: noHooks,
      sessionId: ID,
      enabled: true,
      userExtraArgs: [],
    });
    expect(r.args).toEqual([]);
  });

  it("does NOT double-inject when the consumer already passed the agent's flag", () => {
    const r = buildHookInjection({
      agent: claude,
      sessionId: ID,
      enabled: true,
      userExtraArgs: ["--settings", "{}"],
    });
    expect(r.args).toEqual([]);
    expect(r.rendezvousPath).toBeUndefined();
  });
});
