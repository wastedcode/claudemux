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

/**
 * Pane-text substrings that classify a Claude Code permission prompt.
 *
 * **Empty by design for v0.0.1** — per [[decisions/0010-claudemux-owns-no-config]]
 * permission-prompt *detection and handling defer to v0.1 as one unit*. The
 * `permission-prompt` state is a reserved (forward-compat) member of the
 * public `wait()`/`state()` return type that v0.0.1 never emits; v0.1 starts
 * emitting it (non-breaking) together with a `respond()` primitive that can
 * actually answer the prompt. Emitting detection without `respond()` would
 * be a half-feature: the end state is identical either way — for unattended
 * use you set a non-interactive permission mode yourself.
 *
 * With no substrings the `permissionPrompt` rule returns `false`, so a prompt
 * classifies as `unknown` (never `idle` — it is never mistaken for a finished
 * turn). A session left in interactive `default` mode that hits a prompt has
 * nothing to answer it, so `wait()` elapses its budget and throws
 * `ReplTimeout`; the documented fix is to run a non-interactive permission
 * mode (claude `--permission-mode bypassPermissions`/`acceptEdits` via
 * `extraArgs`, or `~/.claude` settings) — see README §5.
 *
 * The enumerated prompt shapes against authenticated claude live in
 * `research/fixtures/permission-prompt-classifier-fixture.json` (e.g. the
 * 2.1.153 header `"Do you want to "`) — kept as the v0.1 starting point.
 */
const PERMISSION_PROMPT_SUBSTRINGS: readonly string[] = [];

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
    // claude 2.1.153 wording: "Quick safety check: Is this a project you
    // created or one you trust? … ❯ 1. Yes, I trust this folder". Match the
    // option-label substring "trust this folder" — resilient to header copy
    // edits. (Verified against authenticated 2.1.153 at product-acceptance.)
    matches: (pane) => pane.includes("trust this folder"),
    // Trusting a folder is an authority grant — fail closed. boot.ts throws
    // WorkspaceUntrusted *before* sending "1" unless the consumer opted in
    // via trustWorkspace. The "1" is the dismiss key used only when opted in.
    respond: { kind: "key", key: "1" },
    gate: { option: "trustWorkspace", errorClass: "WorkspaceUntrusted" },
  },
];

/**
 * Is the REPL idle and ready for *new* input? True when the bottom-N pane
 * contains an **empty** input box — a line that is exactly the ready glyph
 * followed by only whitespace (`/^❯\s*$/`; the empty box is `❯` + U+00A0 in
 * claude 2.1.153, and `\s` covers U+00A0).
 *
 * Three things this gets right, all confirmed against authenticated 2.1.153:
 *   - **Footer below the prompt.** 2.1.153 renders a status footer
 *     (`⏵⏵ bypass permissions on …` or `? for shortcuts …`) on the line(s)
 *     *below* `❯`, so the bottom-most non-blank line is the footer, not the
 *     prompt. Scanning bottom-N for the box (not taking the last line) fixes
 *     spawn-ready, `state→idle`, and `wait`.
 *   - **Draft echo is NOT idle.** A pasted-but-unsubmitted turn shows
 *     `❯ <draft text>` — non-empty after the glyph — so it does not match.
 *     This is what stops `wait` from reading the post-`send` echo as a
 *     completed turn (silent turn-loss).
 *   - **Menu selection is NOT idle.** Theme/trust menus render `❯ 1. …` (a
 *     digit follows) and are indented, so they don't match the column-0
 *     empty box. (Dialogs are also caught earlier by their own matchers.)
 *
 * NOTE: structural readiness is necessary but not sufficient — the caller
 * (`boot.ts`) must also confirm the pane is *stable* before declaring ready,
 * because the empty box can flash during the welcome/MCP-init render before
 * input is actually interactive. See `wait-needs-a-transition-not-a-snapshot`.
 */
const EMPTY_PROMPT = /^❯\s*$/;
function isReady(paneTextBottomN: string): boolean {
  return paneTextBottomN.split("\n").some((line) => EMPTY_PROMPT.test(line));
}

const rules: ClassifierRules = {
  // Dialog predicate: any of the known boot-dialog matchers firing.
  // Mirrors the dialog list above so the classifier doesn't drift apart.
  dialog: (text) => dialog.some((d) => d.matches(text)),
  permissionPrompt: (text) => PERMISSION_PROMPT_SUBSTRINGS.some((s) => text.includes(s)),
  // "esc to interrupt" is the reliable in-flight signal — present for the
  // whole turn (verified ~2.2s on a trivial reply against 2.1.153). The
  // post-turn summary (`✻ Crunched for 1s`) does NOT contain it, so matching
  // the bare `✻` spinner glyph would false-positive on a *completed* turn.
  // (The old gerund list `Cooking`/`Crafting` was stale — 2.1.153 uses
  // `Brewing`/`Crunched`/… — and dead weight given the reliable signal.)
  working: (text) => text.includes("esc to interrupt"),
  // Idle is the empty-input-box check.
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
