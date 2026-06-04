// Vitest suite that replays each scenario in
// permission-prompt-classifier-fixture.json against a pinned claude under
// sandboxed primitives (ephemeral HOME + private tmux socket). Asserts the
// recorded `promptTextSnippet` still appears in the captured pane when the
// corresponding trigger fires.
//
// Per-scenario timeout: 30s. Output cap: 64 KB.
//
// This is the v0.1 starting point for the permission-prompt classifier
// (`PERMISSION_PROMPT_SUBSTRINGS` in src/agents/claude.ts, intentionally empty
// in v0.0.1 — detection+handling defer to v0.1 as one unit per ADR 0010).
//
// ⚠ This suite spawns a REAL authenticated claude that talks to the network and
// replays untrusted pane-text scenarios, so the live run belongs only under a
// dedicated `--network=none` workflow (its original was retired with ADR 0010
// Path B; re-introduced in v0.1). It is therefore EXCLUDED from the general
// suite via vitest.config.ts, and double-gated below on
// CLAUDEMUX_LIVE_PERMISSION_PROMPTS=1 so the live path never fires by accident.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const FIXTURE_PATH = resolve(__dirname, "permission-prompt-classifier-fixture.json");
const PER_SCENARIO_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 64 * 1024;

type Scenario = {
  id: string;
  trigger: { tool: string; args: Record<string, unknown>; prompt?: string };
  flags: string[];
  expectsPrompt: boolean;
  promptTextSnippet?: string;
};

type Fixture = {
  purpose: string;
  claudeVersion: string;
  scenarios: Scenario[];
};

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const tmuxSocket = "claudemux-prompts-test";

function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-L", tmuxSocket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: OUTPUT_CAP_BYTES,
  });
}

function tryTmuxKillServer(): void {
  try {
    execFileSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" });
  } catch {
    /* server may not exist yet */
  }
}

beforeAll(() => {
  // Belt-and-braces: CI hard-fails if cwd is the repo root or if HOME
  // matches a real-home pattern. This protects against the workflow being
  // misconfigured and running on a non-ephemeral runner.
  const cwd = process.cwd();
  if (/\/(claudemux|tclaude)(\/|$)/.test(cwd) && !cwd.includes("/.posse/")) {
    if (/\/(home|Users)\/[^/]+\/?$/.test(process.env.HOME ?? "")) {
      throw new Error(
        "permission-prompts.test.ts: cwd looks like a repo root AND HOME matches a real-home pattern. Refusing to run.",
      );
    }
  }
});

// Belt-and-braces with the vitest.config.ts exclusion: the live path requires
// authenticated claude under network isolation, so it only runs when the v0.1
// workflow opts in explicitly. Exact `=== '1'` so `=0`/`=false`/empty fail safe.
const LIVE = process.env.CLAUDEMUX_LIVE_PERMISSION_PROMPTS === "1";

describe("permission-prompt classifier predicates", () => {
  if (!LIVE) {
    it.skip("auth-gated replay — set CLAUDEMUX_LIVE_PERMISSION_PROMPTS=1 AND run under the network-isolated v0.1 workflow to enable", () => {});
    return;
  }
  if (fixture.scenarios.length === 0) {
    it.skip("fixture pending enumeration — populate at substrate-build acceptance pass with authenticated claude", () => {});
    return;
  }

  for (const scenario of fixture.scenarios) {
    it(
      scenario.id,
      async () => {
        tryTmuxKillServer();
        const sandboxHome = mkdtempSync(join(tmpdir(), "claudemux-prompts-"));
        // Marker file so a failed test can tell if the trigger ran at all.
        writeFileSync(join(sandboxHome, ".probe-marker"), scenario.id);

        try {
          // Build the claude argv from scenario.flags. Claude binary path
          // comes from PATH in CI.
          const claudeArgs = [...scenario.flags];

          // Start the agent in a tmux pane under the private socket.
          tmux("new-session", "-d", "-s", "ka", "sleep", "60");
          tmux(
            "new-session",
            "-d",
            "-s",
            scenario.id,
            "-x",
            "120",
            "-y",
            "40",
            "env",
            "-i",
            `HOME=${sandboxHome}`,
            `XDG_CONFIG_HOME=${sandboxHome}/.config`,
            `XDG_DATA_HOME=${sandboxHome}/.local/share`,
            `XDG_CACHE_HOME=${sandboxHome}/.cache`,
            `XDG_STATE_HOME=${sandboxHome}/.local/state`,
            "PATH=/home/runner/.local/bin:/usr/local/bin:/usr/bin:/bin",
            "TERM=xterm-256color",
            "LC_ALL=C.UTF-8",
            "claude",
            ...claudeArgs,
          );

          // A fresh sandbox HOME means the first run shows the workspace-trust
          // dialog before the REPL is usable — dismiss it (option 1) so the
          // trigger lands at a real prompt, not the dialog. Best-effort: if the
          // dialog never appears (already-trusted path), the "1"+Enter is a
          // harmless no-op the composer clears.
          await settleForBoot(scenario.id);

          // Send the trigger: type the tool-invoking prompt and submit. The
          // prompt is enumerated per-scenario in the fixture; submitting it
          // makes claude attempt the tool, which raises the permission prompt
          // under `--permission-mode default`.
          await sendTrigger(scenario);

          // Settle, then capture.
          await new Promise((r) => setTimeout(r, 6000));
          const pane = tmux("capture-pane", "-p", "-t", scenario.id);

          if (scenario.expectsPrompt) {
            expect(pane.length).toBeLessThan(OUTPUT_CAP_BYTES);
            expect(pane).toContain(scenario.promptTextSnippet);
          } else {
            if (scenario.promptTextSnippet) {
              expect(pane).not.toContain(scenario.promptTextSnippet);
            }
          }
        } finally {
          tryTmuxKillServer();
        }
      },
      PER_SCENARIO_TIMEOUT_MS,
    );
  }
});

/**
 * Wait out boot and dismiss the first-run workspace-trust dialog. Polls the
 * pane up to ~12s: if "trust this folder" shows, answers option 1 (send-keys
 * "1" then Enter) and waits for it to clear; returns once a `❯` input box is
 * present (or the budget elapses — the trigger still gets a shot).
 */
async function settleForBoot(session: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const pane = tmux("capture-pane", "-p", "-t", session);
    if (pane.includes("trust this folder")) {
      tmux("send-keys", "-t", session, "1");
      tmux("send-keys", "-t", session, "Enter");
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (pane.includes("❯")) return; // REPL ready for input
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function sendTrigger(scenario: Scenario): Promise<void> {
  // Type the tool-invoking prompt (literal, then Enter to submit). Falls back
  // to a Write-tool instruction derived from the trigger when no explicit
  // prompt is enumerated — every shape SHOULD carry an explicit `prompt`.
  const prompt =
    scenario.trigger.prompt ??
    `Use the ${scenario.trigger.tool} tool with ${JSON.stringify(scenario.trigger.args)}.`;
  tmux("send-keys", "-t", scenario.id, "-l", prompt);
  tmux("send-keys", "-t", scenario.id, "Enter");
}
