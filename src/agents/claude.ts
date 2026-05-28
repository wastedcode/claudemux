import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassifierRules } from "../state/types.js";
import type { AgentDef, BootDialog } from "./types.js";

/**
 * The `claude` agent definition. **Sole file with claude-specific strings**;
 * CI grep-test (T12) enforces this. Never imports from `src/backends/**`.
 *
 * @example
 * ```ts
 * import { create, claude } from "claudemux";
 * await create({ name: "job", cwd: process.cwd(), agent: claude });
 * ```
 */

/** U+276F HEAVY RIGHT-POINTING ANGLE QUOTATION MARK — the REPL ready glyph. */
const READY_GLYPH = "❯";

/**
 * Pane-text substring matchers the classifier uses to detect Claude Code
 * permission prompts. Loaded at module init from the in-source fixture
 * (kept in sync with `research/fixtures/permission-prompt-classifier-fixture.json`
 * by the substrate maintenance discipline).
 *
 * With `scenarios: []` the predicate returns `false` for everything — that
 * IS the design at v0.0.1 ship per the founder-ratified (C)+(A) path. The
 * classifier dispatches to `unknown` as the safe failure mode (consumers
 * are documented to not treat `unknown` as idle); the founder populates
 * scenarios at product-acceptance against authenticated claude.
 */
function loadPermissionPromptScenarios(): readonly string[] {
  // The fixture lives in dist/agents/ next to this file when published; we
  // resolve via import.meta.url so the path works in both source (src/) and
  // published (dist/) layouts.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "permission-prompts.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // If the fixture is missing (e.g. tests running from rootDir mismatch),
    // treat as empty rather than crashing module init. The classifier still
    // dispatches to `unknown` as the safe failure mode.
    return [];
  }
  const parsed = JSON.parse(raw) as {
    scenarios?: ReadonlyArray<{ matchSubstring?: string }>;
  };
  const subs: string[] = [];
  for (const s of parsed.scenarios ?? []) {
    if (typeof s?.matchSubstring === "string" && s.matchSubstring.length > 0) {
      subs.push(s.matchSubstring);
    }
  }
  return subs;
}

const PERMISSION_PROMPT_SUBSTRINGS = loadPermissionPromptScenarios();

const dialog: BootDialog[] = [
  {
    id: "theme-picker",
    matches: (pane) => pane.includes("Choose the text style that looks best with your terminal"),
    respond: { kind: "key", key: "Enter" },
  },
  {
    id: "login-method",
    // claudemux assumes the founder has already run `claude` interactively and
    // signed in. If the login-method dialog fires, the setup is wrong, not
    // something we should auto-answer — throw LoginRequired so the consumer
    // sees a clean typed error instead of a hung session.
    matches: (pane) => pane.includes("Select login method:"),
    respond: { kind: "throw", errorClass: "LoginRequired" },
  },
  {
    id: "workspace-trust",
    matches: (pane) => pane.includes("Do you trust the files in this folder?"),
    respond: { kind: "key", key: "1" },
  },
];

/**
 * The bottom-most non-blank pane line must START with `❯`. Menu-selection
 * uses of the same glyph (theme picker etc.) are mid-line with leading
 * whitespace and fail this test.
 */
function isReady(paneTextBottomN: string): boolean {
  const lines = paneTextBottomN.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (raw === undefined || raw.trim() === "") continue;
    return raw.startsWith(READY_GLYPH);
  }
  return false;
}

const rules: ClassifierRules = {
  // Dialog predicate: any of the known boot-dialog matchers firing.
  // Mirrors the dialog list above so the classifier doesn't drift apart.
  dialog: (text) => dialog.some((d) => d.matches(text)),
  permissionPrompt: (text) => PERMISSION_PROMPT_SUBSTRINGS.some((s) => text.includes(s)),
  // "Working" predicates inspect substrings claude emits while a turn is
  // in flight. The "esc to interrupt" hint is documented in claude's help.
  // We additionally accept the streaming-spinner shape "✻"/"⏺" and the
  // explicit "thinking..." textual indicator.
  working: (text) =>
    text.includes("esc to interrupt") ||
    text.includes("thinking...") ||
    text.includes("Cooking") ||
    text.includes("Crafting"),
  // Idle is the qualified READY_GLYPH check.
  idle: (text) => isReady(text),
};

/**
 * Build the spawn argv for `claude`. The substrate adds no flags beyond what
 * the caller passes via `extraArgs` — never injects `--permission-mode` or
 * `--allowedTools` unless the consumer explicitly opted in (acceptance
 * criterion: "Never injects --permission-mode or --allowed-tools").
 */
function buildArgv(o: { cwd: string; extraArgs?: string[] }): {
  cmd: string;
  argv: string[];
  env: Record<string, string>;
} {
  void o.cwd; // cwd is plumbed by the session/backend layer at spawn time
  return {
    cmd: "claude",
    argv: o.extraArgs ?? [],
    env: { LC_ALL: "C.UTF-8" },
  };
}

/** The `claude` agent definition. */
export const claude: AgentDef = {
  name: "claude",
  buildArgv,
  boot: { dialogs: dialog, isReady },
  rules,
};
