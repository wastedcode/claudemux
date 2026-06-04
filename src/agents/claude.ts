import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentSessionIdConflict } from "../errors.js";
import type { ClassifierRules } from "../state/types.js";
import type { Message, MessagePart, PromptChoice } from "../types.js";
import { stripSgr } from "../util/ansi.js";
import type { AgentDef, BootDialog, HookEdge } from "./types.js";

/** Pane-substring test that ignores SGR styling (the pane is captured with `-e`). */
const includesPlain = (pane: string, needle: string): boolean => stripSgr(pane).includes(needle);

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
 * **The stable signal is the prompt header `Do you want to <verb> <target>?`** —
 * it precedes the `❯ 1. Yes / 2. Yes, allow all… / 3. No` menu for every
 * tool class (Write/Edit/Bash/WebFetch/MCP). The trailing-space anchor
 * `"Do you want to "` avoids matching the same phrase in prose. Verified
 * verbatim against authenticated claude 2.1.162 (Write hello.txt → the pane
 * reads `Do you want to create hello.txt?`); first enumerated on 2.1.153.
 *
 * Per [[decisions/0010-claudemux-owns-no-config]] detection and handling are
 * **one unit** — this matcher is populated together with the menu mapping in
 * {@link permissionPrompt} and the handle's `respond()`. A detected prompt now
 * classifies as `permission-prompt` (still never `idle`), and `wait()` surfaces
 * it as `{ kind: "awaiting", on: "permission-prompt" }` for the consumer to
 * answer. The enumerated shapes live in
 * `test/fixtures/permission-prompt-classifier-fixture.json`; the auth-gated
 * replay (`permission-prompts.test.ts`) re-triggers each under network
 * isolation. See README §5.
 */
const PERMISSION_PROMPT_SUBSTRINGS: readonly string[] = ["Do you want to "];

/**
 * The selected first option of the approval menu — the cursor arrow `❯` then
 * `1.`. This is the STRUCTURAL half of the classifier and it is what makes the
 * header safe: the classifier scans the full visible region (40 rows), so a
 * *completed* turn whose reply tail happens to end "…do you want to proceed?"
 * sits in the window right above the empty input box, and an in-flight turn can
 * stream the same phrase. The header substring alone would mis-fire on both.
 * Requiring an actual selectable `❯ 1.` menu line — which an assistant reply
 * never renders — disambiguates a real prompt from prose. (Boot dialogs also
 * render `❯ 1.`, but they lack the header AND are classified *before*
 * permission-prompt, so they never reach here.)
 */
const PERMISSION_PROMPT_MENU = /❯ ?1\.\s/;

/**
 * True when the captured pane shows a tool-approval prompt: the header
 * (`Do you want to …?`) AND the selectable `❯ 1.` menu both present. Both
 * halves are required — see {@link PERMISSION_PROMPT_MENU}.
 */
function isPermissionPrompt(text: string): boolean {
  const plain = stripSgr(text);
  return (
    PERMISSION_PROMPT_SUBSTRINGS.some((s) => plain.includes(s)) &&
    PERMISSION_PROMPT_MENU.test(plain)
  );
}

/**
 * The keystroke that selects each neutral {@link PromptChoice} in claude's
 * tool-approval menu. claude's option order is stable across tool classes:
 * `1. Yes` (approve once) · `2. Yes, allow all … during this session` ·
 * `3. No`. A bare digit selects AND confirms — no Enter (verified against
 * authenticated claude 2.1.162: sending `1` to the Write prompt wrote the file
 * immediately). The SOLE place that knows this order (layering grep keeps the
 * vocabulary out of the agent-agnostic layers).
 */
const PERMISSION_PROMPT_CHOICE_KEYS: Record<PromptChoice, "1" | "2" | "3"> = {
  approve: "1",
  "approve-for-session": "2",
  deny: "3",
};

const dialog: BootDialog[] = [
  {
    id: "theme-picker",
    matches: (pane) =>
      includesPlain(pane, "Choose the text style that looks best with your terminal"),
    respond: { kind: "key", key: "Enter" },
  },
  {
    id: "login-method",
    // claudemux assumes the founder has already run `claude` interactively and
    // signed in. If the login-method dialog fires, the setup is wrong, not
    // something we should auto-answer — throw LoginRequired so the consumer
    // sees a clean typed error instead of a hung session.
    matches: (pane) => includesPlain(pane, "Select login method:"),
    respond: { kind: "throw", errorClass: "LoginRequired" },
  },
  {
    id: "workspace-trust",
    // claude 2.1.153 wording: "Quick safety check: Is this a project you
    // created or one you trust? … ❯ 1. Yes, I trust this folder". Match the
    // option-label substring "trust this folder" — resilient to header copy
    // edits. (Verified against authenticated 2.1.153 at product-acceptance.)
    matches: (pane) => includesPlain(pane, "trust this folder"),
    // Trusting a folder is an authority grant — fail closed. boot.ts throws
    // WorkspaceUntrusted *before* sending "1" unless the consumer opted in
    // via trustWorkspace. The "1" is the dismiss key used only when opted in.
    respond: { kind: "key", key: "1" },
    gate: { option: "trustWorkspace", errorClass: "WorkspaceUntrusted" },
  },
];

/**
 * Is the REPL idle and ready for *new* input? True when the bottom-N pane
 * contains an **empty** input box: a line that begins (at column 0) with the
 * ready glyph `❯` and carries no *real* draft after it.
 *
 * **Why this needs ANSI styling (`capture -e`).** Since claude 2.1.16x the idle
 * box is not blank — it shows a dim "ghost" placeholder hint, e.g.
 * `❯ Try "how does <filepath> work?"`. In *plain* text that is indistinguishable
 * from a real unsubmitted draft `❯ how does …`, so a plain-text check either
 * mis-reads the placeholder as a draft (boot/`wait` hang — the bug this fixes)
 * or, if it ignored trailing text, mis-reads a real draft as idle (silent
 * turn-loss). The two are only separable by **intensity**: the placeholder is
 * SGR-faint (code 2) and the block cursor is reverse-video (code 7); a real
 * draft is normal intensity. So {@link lineIsEmptyBox} interprets the SGR state
 * and treats only normal-intensity, non-cursor glyphs after `❯` as a draft.
 * Verified against authenticated claude 2.1.162 (the ghost line decodes to
 * `\e[39m❯ \e[7mT\e[0;2mry "…"\e[0m`; a draft to `\e[39m❯ hello\e[7m \e[0m`).
 *
 * What this still gets right (all confirmed against 2.1.162):
 *   - **Footer below the prompt** (`⏵⏵ bypass permissions …` / `? for shortcuts`)
 *     is not at column 0 with a leading `❯`, so scanning bottom-N for the box
 *     (not taking the last non-blank line) keeps boot / `state→idle` / `wait`
 *     anchored on the prompt.
 *   - **Draft echo is NOT idle** — normal-intensity glyphs after `❯`.
 *   - **Menu selection is NOT idle** — `❯ 1. …` has a normal-intensity digit.
 *
 * NOTE: on a *plain* (non-`-e`) capture the placeholder reads as a draft and
 * this returns `false` — callers that need idle-detection must capture with
 * ANSI on (see `CLASSIFIER_CAPTURE`). Structural readiness is also necessary
 * but not sufficient: `boot.ts` confirms the pane is *stable* before declaring
 * ready (the box can flash mid-render). The reliable boot-ready signal is the
 * `SessionStart` hook edge; this pane check is the no-hooks fallback. See
 * `wait-needs-a-transition-not-a-snapshot`.
 */
const PROMPT_GLYPH = "❯";
function lineIsEmptyBox(line: string): boolean {
  let dim = false; // SGR 2 (faint) — the ghost placeholder hint
  let reverse = false; // SGR 7 — the block cursor, not user content
  let sawPrompt = false;
  let i = 0;
  while (i < line.length) {
    // SGR escape: ESC [ <params> m — update style state, consume, continue.
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && line[j] !== "m") j++;
      for (const p of line.slice(i + 2, j).split(";")) {
        if (p === "" || p === "0") {
          dim = false;
          reverse = false;
        } else if (p === "2") dim = true;
        else if (p === "22") dim = false;
        else if (p === "7") reverse = true;
        else if (p === "27") reverse = false;
      }
      i = j + 1;
      continue;
    }
    const ch = line[i++];
    if (ch === undefined) break;
    if (!sawPrompt) {
      // The box must start at column 0 (after any leading SGR) — anything else
      // first (incl. indentation) means this line isn't the prompt.
      if (ch === PROMPT_GLYPH) {
        sawPrompt = true;
        continue;
      }
      return false;
    }
    if (/\s/.test(ch)) continue; // whitespace / U+00A0 padding
    if (reverse || dim) continue; // block cursor / dim ghost-placeholder hint
    return false; // a normal-intensity glyph after ❯ → a real draft, not idle
  }
  return sawPrompt;
}
function isReady(paneTextBottomN: string): boolean {
  return paneTextBottomN.split("\n").some(lineIsEmptyBox);
}

const rules: ClassifierRules = {
  // Dialog predicate: any of the known boot-dialog matchers firing.
  // Mirrors the dialog list above so the classifier doesn't drift apart.
  dialog: (text) => dialog.some((d) => d.matches(text)),
  permissionPrompt: (text) => isPermissionPrompt(text),
  // "esc to interrupt" is the reliable in-flight signal — present for the
  // whole turn (verified ~2.2s on a trivial reply against 2.1.153). The
  // post-turn summary (`✻ Crunched for 1s`) does NOT contain it, so matching
  // the bare `✻` spinner glyph would false-positive on a *completed* turn.
  // (The old gerund list `Cooking`/`Crafting` was stale — 2.1.153 uses
  // `Brewing`/`Crunched`/… — and dead weight given the reliable signal.)
  working: (text) => includesPlain(text, "esc to interrupt"),
  // Idle is the empty-input-box check.
  idle: (text) => isReady(text),
  // A turn stopped by ESC renders "Interrupted" (verified on 2.1.162 in the
  // interrupt acceptance scenario). Interrupt fires NO `stop` hook, so this
  // pane marker is the only signal — the Observer maps it to `aborted`.
  interrupted: (text) => includesPlain(text, "Interrupted"),
};

/**
 * claude's conversation-identity flags. **The only place that knows these
 * strings** (layering-grep T12 keeps the `--session-id` vocabulary out of the
 * session layer). `create()` mints a neutral `sessionId`; *this* file decides
 * it becomes `--session-id`, and recognizes a caller's own identity flag in
 * `extraArgs` so the substrate never emits two.
 */
const SESSION_ID_FLAG = "--session-id";
const RESUME_FLAGS = ["--resume", "-r"];
const FORK_FLAG = "--fork-session";

/**
 * What identity flag (if any) the caller already put in `extraArgs`, and the
 * id it selects. For `session-id`/`resume`, `value === undefined` means "an id
 * we cannot know up front" (a bare `--resume`). `fork` carries no value at all
 * — a `--fork-session` resumes into a fresh id we can never know. Both cases
 * surface `agentSessionId` as `undefined` — the only paths where it is honestly
 * unknowable.
 */
type CallerIdentity =
  | { kind: "session-id"; value: string | undefined }
  | { kind: "resume"; value: string | undefined }
  | { kind: "fork" };

function findCallerIdentity(extraArgs: readonly string[]): CallerIdentity | undefined {
  // A `--fork-session` anywhere means claude resumes into a NEW id we can't
  // know — it dominates a co-present --resume/--session-id for the surfaced id.
  if (extraArgs.includes(FORK_FLAG)) return { kind: "fork" };

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === undefined) continue;
    // `--session-id <x>` or `--session-id=<x>`.
    if (arg === SESSION_ID_FLAG) return { kind: "session-id", value: extraArgs[i + 1] };
    if (arg.startsWith(`${SESSION_ID_FLAG}=`)) {
      return { kind: "session-id", value: arg.slice(SESSION_ID_FLAG.length + 1) };
    }
    // `-r`/`--resume [value]` (optional value) or `--resume=<id>`.
    if (RESUME_FLAGS.includes(arg)) {
      const next = extraArgs[i + 1];
      // Bare resume: nothing follows, or the next token is itself a flag.
      const value = next !== undefined && !next.startsWith("-") ? next : undefined;
      return { kind: "resume", value };
    }
    const resumeEq = RESUME_FLAGS.map((f) => `${f}=`).find((p) => arg.startsWith(p));
    if (resumeEq) return { kind: "resume", value: arg.slice(resumeEq.length) };
  }
  return undefined;
}

/**
 * Build the spawn argv for `claude`.
 *
 * **Identity:** the substrate always knows the conversation id up front — see
 * `create()`'s mint. This builder maps the neutral `sessionId` to claude's
 * `--session-id <id>`, emitted as **two adjacent argv elements** (never
 * `--session-id=<id>`, never string-joined, never via `send-keys`). That
 * single-argv-element shape is a *security invariant*, not just a style: every
 * element is passed to the backend verbatim with no shell, so a value can never
 * be re-parsed as a flag or (in tmux's argv grammar, where a bare `;` is a
 * command separator) a second command. `create()` validates the id is a v4
 * UUID before we ever get here, so the value cannot be `;`, a path, or any
 * meaningful token — but the two-element shape is what makes that validation
 * sufficient.
 *
 * **Caller-wins precedence** (a caller's own identity flag in `extraArgs`
 * always wins; we never emit two `--session-id`):
 *   - no identity flag → inject `--session-id <sessionId>`, return `sessionId`.
 *   - `--session-id <x>` → pass through, suppress mint, return `x`.
 *   - `--resume <id>` → pass through, suppress mint, return `id`.
 *   - bare `--resume` / `--fork-session` → pass through, suppress mint, return
 *     `undefined` (claude picks the id; the one path we can't know it).
 *   - any of the above **and** `sessionIdExplicit` → fail fast with
 *     `AgentSessionIdConflict` (the caller insisted on an id two ways).
 *
 * Beyond identity the substrate adds no flags — never injects
 * `--permission-mode` or `--allowedTools` unless the consumer opted in via
 * `extraArgs` (acceptance criterion: "Never injects --permission-mode or
 * --allowed-tools"). `--session-id` grants no authority — it only names the
 * conversation — so always-minting it does not breach that criterion.
 */
function buildArgv(o: {
  cwd: string;
  extraArgs?: string[];
  sessionId?: string;
  sessionIdExplicit?: boolean;
  resumeFrom?: string;
  sessionName?: string;
}): {
  cmd: string;
  argv: string[];
  env: Record<string, string>;
  agentSessionId?: string;
} {
  void o.cwd; // cwd is plumbed by the session/backend layer at spawn time
  const extraArgs = o.extraArgs ?? [];
  const env = { LC_ALL: "C.UTF-8" };

  // Neutral resume request (from the session layer's `resume()`): map it to
  // `--resume <id>` — the SOLE place that vendor flag is written. Emitted as two
  // adjacent argv elements (the same security invariant as `--session-id`). A
  // co-present caller identity flag in extraArgs is choosing the id two ways.
  if (o.resumeFrom !== undefined) {
    if (findCallerIdentity(extraArgs)) throw new AgentSessionIdConflict(o.sessionName ?? "");
    return {
      cmd: "claude",
      argv: [RESUME_FLAGS[0] as string, o.resumeFrom, ...extraArgs],
      env,
      agentSessionId: o.resumeFrom,
    };
  }

  const caller = findCallerIdentity(extraArgs);
  if (caller) {
    // A caller-chosen identity flag conflicts with an explicit agentSessionId:
    // the caller asked for an id two different ways. Fail fast before spawn.
    if (o.sessionIdExplicit) {
      throw new AgentSessionIdConflict(o.sessionName ?? "");
    }
    // Otherwise the caller's flag wins and the mint is suppressed. Pass
    // extraArgs through verbatim; surface the id the flag selects (or undefined
    // for a bare resume / fork, which we genuinely cannot know up front).
    const surfaced = caller.kind === "fork" ? undefined : caller.value;
    return {
      cmd: "claude",
      argv: extraArgs,
      env,
      ...(surfaced === undefined ? {} : { agentSessionId: surfaced }),
    };
  }

  // No caller identity flag. Inject the substrate's id if we have one. The flag
  // and its value are TWO adjacent argv elements — never joined (the invariant).
  if (o.sessionId !== undefined) {
    return {
      cmd: "claude",
      argv: [SESSION_ID_FLAG, o.sessionId, ...extraArgs],
      env,
      agentSessionId: o.sessionId,
    };
  }

  // No id at all (e.g. an internal caller that didn't mint one) — pass through.
  return { cmd: "claude", argv: extraArgs, env };
}

/** The `claude` agent definition. */
// ─── Transcript reading (claude's on-disk session log) ──────────────────────
// claude writes the session transcript to
// `<home>/.claude/projects/<cwd-slug>/<session-id>.jsonl`, append-only (verified
// + docs-confirmed: compaction summarizes the context window, never rewrites the
// file). The cwd→slug rule is fragile (punctuation-substituted), so we locate by
// id-glob across project dirs rather than recompute it.

/** Locate the transcript for a session id by scanning the project dirs. */
function locateTranscript(o: { agentSessionId: string; home?: string }): string | null {
  const projectsDir = join(o.home ?? homedir(), ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of entries) {
    const candidate = join(projectsDir, dir, `${o.agentSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `mcp__<server>__<tool>` → `<tool>`; other names pass through. */
function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const segs = name.split("__");
  return segs[segs.length - 1] ?? name;
}

/** A short, neutral one-line summary of a tool_use input. */
function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // First matching field becomes the one-line summary; extend for new tool input shapes.
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const v = o[key];
    if (typeof v === "string") return v;
  }
  return "";
}

/** A short, neutral summary of a tool_result's content (string or text blocks). */
function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  if (Array.isArray(content)) {
    const text = content
      .map((c) =>
        c !== null && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("");
    return text.slice(0, 200);
  }
  return "";
}

/**
 * Parse one transcript line into a neutral {@link Message}. Returns `null` for
 * a blank line, a partial/half-flushed line (unparseable JSON), or a metadata
 * record (anything that is not a `user`/`assistant` turn-side).
 */
function parseTranscriptLine(line: string): Message | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = rec.type;
  if (type !== "user" && type !== "assistant") return null;
  const msg = rec.message as { content?: unknown } | undefined;
  if (msg === undefined) return null;

  const parts: MessagePart[] = [];
  const content = msg.content;
  if (typeof content === "string") {
    if (content !== "") parts.push({ kind: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push({ kind: "text", text: b.text });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        parts.push({
          kind: "tool",
          tool: stripMcpPrefix(b.name),
          summary: summarizeToolInput(b.input),
        });
      } else if (b.type === "tool_result") {
        parts.push({
          kind: "tool-result",
          ok: b.is_error !== true,
          summary: summarizeToolResult(b.content),
        });
      }
      // `thinking` blocks are intentionally skipped — internal, not conversation.
    }
  }
  if (parts.length === 0) return null;

  const id = typeof rec.uuid === "string" ? rec.uuid : "";
  const parentId = typeof rec.parentUuid === "string" ? rec.parentUuid : undefined;
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
  return {
    id,
    role: type,
    parts,
    ...(parentId === undefined ? {} : { parentId }),
    ...(at === undefined ? {} : { at }),
  };
}

/**
 * A typed user prompt carries a text part; a tool-result-feedback user record
 * carries only tool-result parts (not a new turn).
 */
function isTurnStart(message: Message): boolean {
  return message.role === "user" && message.parts.some((p) => p.kind === "text");
}

/**
 * The raw ancestry link of **any** transcript record (`uuid` → `parentUuid`),
 * not just `user`/`assistant` turns. claude 2.1.162 threads non-message records
 * (e.g. `attachment`) *between* a prompt and its reply — the assistant's
 * `parentUuid` points at an attachment, not the user record — so a causal chain
 * built from surfaced messages alone is severed. Exposing every linkable
 * record's edge lets the consumer bridge those gaps. `null` for blank/partial
 * lines and records with no `uuid` (pure metadata that cannot be a chain link).
 */
function parseTranscriptEdge(line: string): { id: string; parentId?: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof rec.uuid !== "string") return null;
  const parentId = typeof rec.parentUuid === "string" ? rec.parentUuid : undefined;
  return { id: rec.uuid, ...(parentId === undefined ? {} : { parentId }) };
}

// ─── Hook-based turn observation (the reliable, no-pane-scrape signal) ───────
// claude fires hooks the harness can't forget (verified in spike). We inject a
// settings fragment wiring the turn-lifecycle events to append a marker line to
// a claudemux-owned per-session rendezvous file; the Observer reads those as
// deterministic phase edges. Marker line format: "<epoch.ns> <payload-json>\n",
// where the payload (claude's hook stdin) carries hook_event_name/session_id/
// tool_name plus the fusion fields below. The settings shape + this format +
// every claude payload field name live ONLY here (the agent seam translates the
// vendor payload into the neutral HookEdge; field names never leak past it).

/** claude hook event name → neutral edge. */
const HOOK_EVENT_MAP: Record<string, HookEdge["event"]> = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt-submit",
  PreToolUse: "tool-start",
  PostToolUse: "tool-end",
  Stop: "stop",
  Notification: "notification",
  PreCompact: "pre-compact",
};

/** claude `SessionStart` `source` → neutral {@link HookEdge.source}. */
const HOOK_SOURCE_MAP: Record<string, NonNullable<HookEdge["source"]>> = {
  startup: "start",
  resume: "resume",
  clear: "clear",
  compact: "compact",
};

function hookSpec(o: { rendezvousPath: string }): { flag: string; value: string } {
  // Single-quote the path for the shell (claudemux-generated, uuid-based — but
  // quote defensively). Each hook appends "<ts> <stdin-json>\n" to it.
  const quoted = `'${o.rendezvousPath.replace(/'/g, `'\\''`)}'`;
  const command = `{ printf '%s ' "$(date +%s.%N)"; cat; printf '\\n'; } >> ${quoted}`;
  const entry = [{ hooks: [{ type: "command", command }] }];
  const toolEntry = [{ matcher: "*", hooks: [{ type: "command", command }] }];
  const settings = {
    hooks: {
      SessionStart: entry,
      UserPromptSubmit: entry,
      Stop: entry,
      Notification: entry,
      PreCompact: entry,
      PreToolUse: toolEntry,
      PostToolUse: toolEntry,
    },
  };
  return { flag: "--settings", value: JSON.stringify(settings) };
}

function parseMarker(line: string): HookEdge | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const sp = trimmed.indexOf(" ");
  if (sp < 0) return null;
  const at = Math.round(Number.parseFloat(trimmed.slice(0, sp)) * 1000);
  if (!Number.isFinite(at)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(trimmed.slice(sp + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const event = HOOK_EVENT_MAP[name] ?? "other";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  // Fusion fields — translate claude's payload names into the neutral edge.
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : undefined;
  const source = typeof payload.source === "string" ? HOOK_SOURCE_MAP[payload.source] : undefined;
  const finalMessage =
    typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : undefined;
  return {
    event,
    at,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(tool === undefined ? {} : { tool }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(source === undefined ? {} : { source }),
    ...(finalMessage === undefined ? {} : { finalMessage }),
  };
}

export const claude: AgentDef = {
  name: "claude",
  buildArgv,
  boot: { dialogs: dialog, isReady },
  rules,
  permissionPrompt: { respondKey: (choice) => PERMISSION_PROMPT_CHOICE_KEYS[choice] },
  transcript: {
    locate: locateTranscript,
    parseLine: parseTranscriptLine,
    parseEdge: parseTranscriptEdge,
    isTurnStart,
  },
  hooks: { spec: hookSpec, parseMarker },
};
