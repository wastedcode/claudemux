import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSessionIdConflict } from "../errors.js";
import { claude } from "./claude.js";

/**
 * Pane fixtures captured VERBATIM from authenticated claude 2.1.153 at
 * product-acceptance (2026-05-28). These pin the real shapes so a future
 * claude minor that drifts the wording fails `npm test` instead of hanging
 * a consumer's spawn/wait. The empty prompt's box char after `❯` is a
 * non-breaking space (U+00A0) on 2.1.153 — reproduced here with  .
 */
const READY_PANE_2_1_153 = [
  "────────────────────────────────────────────────────────────",
  "❯  ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents          ◉ xhigh · /effort",
].join("\n");

const TRUST_DIALOG_2_1_153 = [
  " Accessing workspace:",
  " /tmp/cmux-untrusted-x",
  " Quick safety check: Is this a project you created or one you trust? (Like your own",
  " code, a well-known open source project, or work from your team).",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
].join("\n");

const PERMISSION_PROMPT_2_1_153 = [
  " Create file",
  " hello.txt",
  " Do you want to create hello.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n");

const WORKING_PANE_2_1_153 = [
  "❯ Reply with exactly: PONG",
  "✻ Brewing… (esc to interrupt · ctrl+t to show todos)",
].join("\n");

const DONE_PANE_2_1_153 = [
  "● PONG",
  "✻ Crunched for 1s",
  "────────────────────────────────────────────────────────────",
  "❯  ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("claude AgentDef", () => {
  it("name and buildArgv shape", () => {
    expect(claude.name).toBe("claude");
    const r = claude.buildArgv({ cwd: "/tmp" });
    expect(r.cmd).toBe("claude");
    expect(r.argv).toEqual([]);
    expect(r.env).toBeDefined();
    expect(r.env?.LC_ALL).toBe("C.UTF-8");
  });

  it("buildArgv passes extraArgs through verbatim, no injection", () => {
    const r = claude.buildArgv({ cwd: "/tmp", extraArgs: ["--print", "hello"] });
    expect(r.argv).toEqual(["--print", "hello"]);
    expect(r.argv).not.toContain("--permission-mode");
    expect(r.argv).not.toContain("--allowedTools");
  });
});

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID2 = "99999999-8888-4777-9666-555555555555";

describe("claude.buildArgv — session-id injection (the always-mint happy path)", () => {
  it("injects --session-id <id> as TWO adjacent argv elements and surfaces it", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID });
    expect(r.argv).toEqual(["--session-id", UUID]);
    expect(r.agentSessionId).toBe(UUID);
    // The flag and its value are at adjacent indices.
    const i = r.argv.indexOf("--session-id");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.argv[i + 1]).toBe(UUID);
  });

  it("the value is NEVER string-joined onto the flag (--session-id=<id>) — argv-injection invariant", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, extraArgs: ["--print"] });
    // No element fuses the flag and its value; the id is its own element.
    expect(r.argv.some((a) => a.startsWith("--session-id="))).toBe(false);
    expect(r.argv).toContain(UUID);
    // Exactly one --session-id flag, ever.
    expect(r.argv.filter((a) => a === "--session-id")).toHaveLength(1);
    // extraArgs still ride alongside the injected pair.
    expect(r.argv).toContain("--print");
  });

  it("no sessionId and no identity flag → passthrough, agentSessionId undefined (back-compat)", () => {
    const r = claude.buildArgv({ cwd: "/tmp", extraArgs: ["--print", "hello"] });
    expect(r.argv).toEqual(["--print", "hello"]);
    expect(r.agentSessionId).toBeUndefined();
  });
});

describe("claude.buildArgv — caller-wins precedence (a caller identity flag always wins; never two --session-id)", () => {
  it("extraArgs --session-id <x> (minted) → passes x through, suppresses the mint, surfaces x", () => {
    const r = claude.buildArgv({
      cwd: "/tmp",
      sessionId: UUID, // the mint
      extraArgs: ["--session-id", UUID2],
    });
    expect(r.argv).toEqual(["--session-id", UUID2]); // mint suppressed, no duplicate
    expect(r.argv.filter((a) => a === "--session-id")).toHaveLength(1);
    expect(r.agentSessionId).toBe(UUID2);
  });

  it("extraArgs --session-id=<x> joined form is recognized and suppresses the mint", () => {
    const r = claude.buildArgv({
      cwd: "/tmp",
      sessionId: UUID,
      extraArgs: [`--session-id=${UUID2}`],
    });
    expect(r.argv).toEqual([`--session-id=${UUID2}`]);
    expect(r.argv).not.toContain(UUID); // mint never emitted
    expect(r.agentSessionId).toBe(UUID2);
  });

  it("extraArgs --resume <id> (minted) → passthrough, suppresses mint, surfaces id", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, extraArgs: ["--resume", UUID2] });
    expect(r.argv).toEqual(["--resume", UUID2]);
    expect(r.argv).not.toContain("--session-id");
    expect(r.agentSessionId).toBe(UUID2);
  });

  it("extraArgs -r <id> shorthand → surfaces id", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, extraArgs: ["-r", UUID2] });
    expect(r.agentSessionId).toBe(UUID2);
    expect(r.argv).not.toContain("--session-id");
  });

  it("extraArgs bare --resume (no value) → passthrough, suppresses mint, surfaces undefined", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, extraArgs: ["--resume"] });
    expect(r.argv).toEqual(["--resume"]);
    expect(r.argv).not.toContain("--session-id");
    expect(r.agentSessionId).toBeUndefined();
  });

  it("extraArgs --resume followed by another flag → treated as bare, surfaces undefined", () => {
    const r = claude.buildArgv({
      cwd: "/tmp",
      sessionId: UUID,
      extraArgs: ["--resume", "--verbose"],
    });
    expect(r.agentSessionId).toBeUndefined();
    expect(r.argv).not.toContain("--session-id");
  });

  it("extraArgs --fork-session → suppresses mint, surfaces undefined (new id, unknowable)", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, extraArgs: ["--fork-session"] });
    expect(r.argv).toEqual(["--fork-session"]);
    expect(r.argv).not.toContain("--session-id");
    expect(r.agentSessionId).toBeUndefined();
  });

  it("--fork-session dominates a co-present --resume <id> (resumes into a new, unknowable id)", () => {
    const r = claude.buildArgv({
      cwd: "/tmp",
      sessionId: UUID,
      extraArgs: ["--resume", UUID2, "--fork-session"],
    });
    expect(r.agentSessionId).toBeUndefined();
    expect(r.argv).not.toContain("--session-id");
  });
});

describe("claude.buildArgv — explicit id conflicting with an extraArgs identity flag fails fast", () => {
  it("explicit agentSessionId + extraArgs --session-id → AgentSessionIdConflict", () => {
    expect(() =>
      claude.buildArgv({
        cwd: "/tmp",
        sessionId: UUID,
        sessionIdExplicit: true,
        sessionName: "claudemux/job",
        extraArgs: ["--session-id", UUID2],
      }),
    ).toThrow(AgentSessionIdConflict);
  });

  it("explicit agentSessionId + extraArgs --resume → AgentSessionIdConflict", () => {
    expect(() =>
      claude.buildArgv({
        cwd: "/tmp",
        sessionId: UUID,
        sessionIdExplicit: true,
        extraArgs: ["--resume", UUID2],
      }),
    ).toThrow(AgentSessionIdConflict);
  });

  it("explicit agentSessionId + bare --fork-session → AgentSessionIdConflict", () => {
    expect(() =>
      claude.buildArgv({
        cwd: "/tmp",
        sessionId: UUID,
        sessionIdExplicit: true,
        extraArgs: ["--fork-session"],
      }),
    ).toThrow(AgentSessionIdConflict);
  });

  it("explicit agentSessionId with NO conflicting flag injects normally", () => {
    const r = claude.buildArgv({ cwd: "/tmp", sessionId: UUID, sessionIdExplicit: true });
    expect(r.argv).toEqual(["--session-id", UUID]);
    expect(r.agentSessionId).toBe(UUID);
  });
});

describe("claude.boot.dialogs (claude 2.1.153)", () => {
  it("theme-picker matches + responds Enter", () => {
    const d = claude.boot.dialogs.find((x) => x.id === "theme-picker");
    expect(d?.matches("Choose the text style that looks best with your terminal\n❯ 2. Dark")).toBe(
      true,
    );
    expect(d?.respond).toEqual({ kind: "key", key: "Enter" });
  });

  it("login-method matches + throws LoginRequired", () => {
    const d = claude.boot.dialogs.find((x) => x.id === "login-method");
    expect(d?.matches("Select login method:\n❯ 1. Claude account")).toBe(true);
    expect(d?.respond).toEqual({ kind: "throw", errorClass: "LoginRequired" });
  });

  it("workspace-trust matches the REAL 2.1.153 dialog + is gated (fail-closed)", () => {
    const d = claude.boot.dialogs.find((x) => x.id === "workspace-trust");
    expect(d).toBeDefined();
    if (!d) return;
    // The matcher must hit the actual 2.1.153 wording (the old
    // "Do you trust the files in this folder?" string is gone).
    expect(d.matches(TRUST_DIALOG_2_1_153)).toBe(true);
    expect(d.matches("Do you trust the files in this folder?")).toBe(false);
    // It carries a trustWorkspace gate → boot fails closed unless opted in.
    expect(d.gate).toEqual({ option: "trustWorkspace", errorClass: "WorkspaceUntrusted" });
    // The dismiss key (used only when opted in) is "1".
    expect(d.respond).toEqual({ kind: "key", key: "1" });
  });
});

describe("claude.boot.isReady — empty-input-box on real 2.1.153 panes", () => {
  it("accepts the REAL ready pane (footer renders BELOW the ❯ box)", () => {
    // The bug this fixes: the bottom-most non-blank line is the footer, not ❯.
    expect(claude.boot.isReady(READY_PANE_2_1_153)).toBe(true);
    expect(claude.boot.isReady(DONE_PANE_2_1_153)).toBe(true);
  });

  it("rejects a pane where the input box has a DRAFT (paste echo) — not idle", () => {
    const draft = [
      "────────────────",
      "❯ Reply with exactly: PONG",
      "────────────────",
      "  ⏵⏵ bypass permissions on",
    ].join("\n");
    expect(claude.boot.isReady(draft)).toBe(false);
  });

  it("rejects the trust/menu ❯ (indented + digit) and the permission prompt", () => {
    expect(claude.boot.isReady(TRUST_DIALOG_2_1_153)).toBe(false);
    expect(claude.boot.isReady(PERMISSION_PROMPT_2_1_153)).toBe(false);
  });

  it("rejects a working pane and an empty pane", () => {
    expect(claude.boot.isReady(WORKING_PANE_2_1_153)).toBe(false);
    expect(claude.boot.isReady("")).toBe(false);
  });
});

describe("permission-prompt is reserved, NOT emitted in v0.0.1 (ADR 0010 — detection+handling are v0.1)", () => {
  it("permissionPrompt returns false for everything — including the real 2.1.153 prompt", () => {
    // Per ADR 0010, detection and handling defer to v0.1 as one unit (a
    // `respond()` primitive lands with detection). v0.0.1 ships the matcher
    // empty: a prompt classifies as `unknown` (NOT idle — property #2 floor
    // holds), and an interactive default-mode session that hits one runs out
    // its wait() budget → ReplTimeout. Documented fix: a non-interactive
    // permission mode (README §5). The enumerated shapes are kept in
    // test/fixtures/ as the v0.1 starting point.
    expect(claude.rules.permissionPrompt(PERMISSION_PROMPT_2_1_153)).toBe(false);
    expect(claude.rules.permissionPrompt("Do you want to make this edit to foo.ts?")).toBe(false);
  });

  it("a permission prompt is therefore NOT idle (never mistaken for a completed turn)", () => {
    // The floor that DOES hold in v0.0.1: a prompt is not the empty input box.
    expect(claude.boot.isReady(PERMISSION_PROMPT_2_1_153)).toBe(false);
    expect(claude.rules.idle(PERMISSION_PROMPT_2_1_153)).toBe(false);
  });
});

describe("claude.rules — classifier on real 2.1.153 frames", () => {
  it("dialog fires for theme/login/trust", () => {
    expect(claude.rules.dialog(TRUST_DIALOG_2_1_153)).toBe(true);
    expect(claude.rules.dialog("Select login method:")).toBe(true);
    expect(claude.rules.dialog("nothing related")).toBe(false);
  });

  it("working fires on 'esc to interrupt' but NOT on the post-turn summary", () => {
    expect(claude.rules.working(WORKING_PANE_2_1_153)).toBe(true);
    // The done-summary "✻ Crunched for 1s" has no "esc to interrupt" — matching
    // the bare ✻ glyph would false-positive on a COMPLETED turn.
    expect(claude.rules.working(DONE_PANE_2_1_153)).toBe(false);
    expect(claude.rules.working("✻ Crunched for 1s")).toBe(false);
  });

  it("idle is the empty-box check (same as boot.isReady)", () => {
    expect(claude.rules.idle(READY_PANE_2_1_153)).toBe(true);
    expect(claude.rules.idle(WORKING_PANE_2_1_153)).toBe(false);
  });
});

/**
 * Transcript reader fixtures — record shapes captured VERBATIM from
 * authenticated claude 2.1.161 (spike, 2026-06-03). They pin the real schema so
 * a future claude minor that drifts the record shape fails `npm test` instead
 * of silently returning wrong messages to a consumer.
 */
const USER_TYPED =
  '{"parentUuid":"p1","type":"user","message":{"role":"user","content":"Use the Bash tool to run exactly: echo hello-from-spike"},"uuid":"u1","timestamp":"2026-06-03T21:42:39.052Z","promptSource":"typed"}';
const ASSISTANT_TEXT =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll run that command."}],"stop_reason":"tool_use"},"uuid":"a1","timestamp":"2026-06-03T21:42:41.000Z"}';
const ASSISTANT_TOOLUSE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo hello-from-spike"}}]},"uuid":"a2"}';
const ASSISTANT_MCP_TOOLUSE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__claude_ai_Notion__notion-search","input":{"query":"roadmap"}}]},"uuid":"a3"}';
const TOOL_RESULT_USER =
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"hello-from-spike\\n","is_error":false}]},"uuid":"u2"}';
const METADATA_RECORD =
  '{"type":"file-history-snapshot","uuid":"m1","timestamp":"2026-06-03T00:00:00Z"}';
const PARTIAL_LINE = '{"type":"assist';

describe("claude transcript reader", () => {
  const tx = claude.transcript;
  if (!tx) throw new Error("claude.transcript must be defined");

  it("parses a typed user prompt → role user, one text part, id+at, isTurnStart", () => {
    const m = tx.parseLine(USER_TYPED);
    expect(m).not.toBeNull();
    expect(m?.role).toBe("user");
    expect(m?.id).toBe("u1");
    expect(m?.at).toBe("2026-06-03T21:42:39.052Z");
    expect(m?.parts).toEqual([
      { kind: "text", text: "Use the Bash tool to run exactly: echo hello-from-spike" },
    ]);
    expect(m && tx.isTurnStart(m)).toBe(true);
  });

  it("parses an assistant text block → role assistant, not a turn start", () => {
    const m = tx.parseLine(ASSISTANT_TEXT);
    expect(m?.role).toBe("assistant");
    expect(m?.parts).toEqual([{ kind: "text", text: "I'll run that command." }]);
    expect(m && tx.isTurnStart(m)).toBe(false);
  });

  it("parses a tool_use block → kind tool, name + input summary", () => {
    const m = tx.parseLine(ASSISTANT_TOOLUSE);
    expect(m?.parts).toEqual([{ kind: "tool", tool: "Bash", summary: "echo hello-from-spike" }]);
  });

  it("strips the mcp__server__ prefix from MCP tool names", () => {
    const m = tx.parseLine(ASSISTANT_MCP_TOOLUSE);
    expect(m?.parts).toEqual([{ kind: "tool", tool: "notion-search", summary: "roadmap" }]);
  });

  it("parses a tool_result-feedback user record → tool-result part, NOT a turn start", () => {
    const m = tx.parseLine(TOOL_RESULT_USER);
    expect(m?.role).toBe("user");
    expect(m?.parts[0]?.kind).toBe("tool-result");
    expect((m?.parts[0] as { ok: boolean }).ok).toBe(true);
    expect(m && tx.isTurnStart(m)).toBe(false);
  });

  it("returns null for metadata, partial, and blank lines (never throws)", () => {
    expect(tx.parseLine(METADATA_RECORD)).toBeNull();
    expect(tx.parseLine(PARTIAL_LINE)).toBeNull();
    expect(tx.parseLine("")).toBeNull();
    expect(tx.parseLine("   ")).toBeNull();
  });

  it("locate finds <id>.jsonl by id-glob across project dirs, null when absent", () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-tx-"));
    try {
      const projDir = join(home, ".claude", "projects", "-some-cwd-slug");
      mkdirSync(projDir, { recursive: true });
      const id = "f3aaa87f-d2e3-4fea-89bf-80cda78d5f22";
      const file = join(projDir, `${id}.jsonl`);
      writeFileSync(file, USER_TYPED);
      expect(tx.locate({ agentSessionId: id, home })).toBe(file);
      expect(tx.locate({ agentSessionId: "no-such-id", home })).toBeNull();
      expect(tx.locate({ agentSessionId: id, home: "/nonexistent/home" })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
