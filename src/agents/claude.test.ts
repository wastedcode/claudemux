import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claude } from "./claude.js";

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

  it("buildArgv with no extraArgs returns []", () => {
    const r = claude.buildArgv({ cwd: "/tmp" });
    expect(r.argv).toEqual([]);
  });
});

describe("claude.boot.dialogs", () => {
  it("theme-picker dialog matches the documented substring", () => {
    const themePane =
      "Choose the text style that looks best with your terminal\n  1. Auto\n❯ 2. Dark mode ✔\n";
    const themeDialog = claude.boot.dialogs.find((d) => d.id === "theme-picker");
    expect(themeDialog).toBeDefined();
    if (!themeDialog) return;
    expect(themeDialog.matches(themePane)).toBe(true);
    expect(themeDialog.matches("nothing related here")).toBe(false);
    expect(themeDialog.respond).toEqual({ kind: "key", key: "Enter" });
  });

  it("login-method dialog throws LoginRequired", () => {
    const loginPane =
      "Select login method:\n  1. Claude account with subscription\n❯ 1. Claude account…\n";
    const loginDialog = claude.boot.dialogs.find((d) => d.id === "login-method");
    expect(loginDialog).toBeDefined();
    if (!loginDialog) return;
    expect(loginDialog.matches(loginPane)).toBe(true);
    expect(loginDialog.matches("Choose the text style…")).toBe(false);
    expect(loginDialog.respond).toEqual({ kind: "throw", errorClass: "LoginRequired" });
  });

  it("workspace-trust dialog responds with '1' + Enter via the key path", () => {
    const trustPane = "Do you trust the files in this folder?\n  1. Yes\n  2. No\n";
    const trustDialog = claude.boot.dialogs.find((d) => d.id === "workspace-trust");
    expect(trustDialog).toBeDefined();
    if (!trustDialog) return;
    expect(trustDialog.matches(trustPane)).toBe(true);
    expect(trustDialog.respond).toEqual({ kind: "key", key: "1" });
  });
});

describe("claude.boot.isReady — bottom-line ❯ qualification", () => {
  it("accepts ❯ at the start of the bottom-most non-blank line (input-box)", () => {
    const pane = ["some history", "more history", "❯ "].join("\n");
    expect(claude.boot.isReady(pane)).toBe(true);
  });

  it("rejects ❯ used mid-line as a menu-selection indicator", () => {
    const pane = [
      "Choose the text style…",
      "  1. Auto (match terminal)",
      "❯ 2. Dark mode ✔",
      "  3. Light mode",
    ].join("\n");
    // The bottom-most non-blank line is "  3. Light mode" (starts with spaces),
    // so isReady returns false.
    expect(claude.boot.isReady(pane)).toBe(false);
  });

  it("rejects when ❯ appears in scrollback but bottom line is something else", () => {
    const pane = ["❯ stale prompt", "Cooking...", "thinking..."].join("\n");
    expect(claude.boot.isReady(pane)).toBe(false);
  });

  it("rejects an empty pane", () => {
    expect(claude.boot.isReady("")).toBe(false);
  });

  it("rejects a menu where ❯ is the bottom-most line but with leading space", () => {
    const pane = ["Choose…", "  ❯ 1. Option"].join("\n");
    expect(claude.boot.isReady(pane)).toBe(false);
  });
});

describe("permission-prompts fixture sync", () => {
  it("runtime fixture (src/agents/permission-prompts.json) mirrors the research fixture", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..");
    const runtime = JSON.parse(
      readFileSync(join(repoRoot, "src/agents/permission-prompts.json"), "utf8"),
    ) as { scenarios: ReadonlyArray<unknown> };
    const research = JSON.parse(
      readFileSync(
        join(repoRoot, "research/fixtures/permission-prompt-classifier-fixture.json"),
        "utf8",
      ),
    ) as { scenarios: ReadonlyArray<unknown> };
    // The substring matchers in both files must match exactly so the
    // research validator + the runtime predicate stay in sync.
    expect(runtime.scenarios).toEqual(research.scenarios);
  });
});

describe("claude.rules — classifier predicates", () => {
  it("dialog fires when any boot-dialog matcher fires", () => {
    expect(claude.rules.dialog("Choose the text style that looks best with your terminal")).toBe(
      true,
    );
    expect(claude.rules.dialog("Select login method:")).toBe(true);
    expect(claude.rules.dialog("nothing related")).toBe(false);
  });

  it("permissionPrompt returns false for all input when scenarios is empty (v0.0.1 default)", () => {
    // (C)+(A) path: scenarios populated at product-acceptance against authenticated claude.
    expect(claude.rules.permissionPrompt("Allow [Y]/n?")).toBe(false);
    expect(claude.rules.permissionPrompt("Permission required")).toBe(false);
    expect(claude.rules.permissionPrompt("")).toBe(false);
  });

  it("working fires on documented streaming-turn substrings", () => {
    expect(claude.rules.working("(esc to interrupt) ")).toBe(true);
    expect(claude.rules.working("Cooking...")).toBe(true);
    expect(claude.rules.working("Crafting...")).toBe(true);
    expect(claude.rules.working("thinking...")).toBe(true);
    expect(claude.rules.working("idle")).toBe(false);
  });

  it("idle uses the qualified ❯-at-bottom rule (same as boot.isReady)", () => {
    expect(claude.rules.idle("❯ ")).toBe(true);
    expect(claude.rules.idle("  ❯ 2. Dark mode")).toBe(false);
  });
});
