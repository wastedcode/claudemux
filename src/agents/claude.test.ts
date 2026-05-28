import { describe, expect, it } from "vitest";
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
