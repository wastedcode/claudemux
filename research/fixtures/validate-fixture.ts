#!/usr/bin/env node
// Schema validator for permission-prompt-classifier-fixture.json.
// Enforces the per-security-infra constraints from
// brain/initiatives/claudemux-v0-0-1-pre-build-research/plan.md §"Security guards".
// Hard-fails the CI lint step on any violation.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURE_PATH = resolve(__dirname, 'permission-prompt-classifier-fixture.json');
const REQUIRED_PURPOSE =
  "This fixture enumerates the pane-text patterns that claudemux's classifier uses to detect Claude Code permission prompts. It is **not** a guide for bypassing Claude Code's permission system. The flags referenced here are public CLI flags; this file documents their *effects on terminal output* for classifier accuracy.";

const BASH_ALLOWED_VERBS = new Set(['echo', 'ls', 'cat', 'pwd', 'touch', 'mkdir']);
const WEBFETCH_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\//;
const MCP_TOOL_RE = /^MCP[A-Z_].*/;

type Scenario = {
  id: string;
  trigger: { tool: string; args: Record<string, unknown> };
  flags: string[];
  expectsPrompt: boolean;
  promptTextSnippet?: string;
  matchedBy?: string;
};

type Fixture = {
  purpose: string;
  claudeVersion: string;
  lastObservedAt: string | null;
  scenarios: Scenario[];
};

const errors: string[] = [];

function fail(msg: string): void {
  errors.push(msg);
}

const raw = readFileSync(FIXTURE_PATH, 'utf8');
let fixture: Fixture;
try {
  fixture = JSON.parse(raw);
} catch (e) {
  console.error(`Fixture is not valid JSON: ${(e as Error).message}`);
  process.exit(1);
}

if (fixture.purpose !== REQUIRED_PURPOSE) {
  fail('`purpose` field MUST be the verbatim mandatory statement.');
}
if (typeof fixture.claudeVersion !== 'string' || fixture.claudeVersion.trim() === '') {
  fail('`claudeVersion` must be a non-empty string (pinned exact version under test).');
}
if (!Array.isArray(fixture.scenarios)) {
  fail('`scenarios` must be an array.');
} else {
  const seenIds = new Set<string>();
  fixture.scenarios.forEach((s, i) => {
    const where = `scenarios[${i}]`;
    if (!s.id || typeof s.id !== 'string') fail(`${where}: id must be a non-empty string`);
    if (s.id) {
      if (seenIds.has(s.id)) fail(`${where}: duplicate id "${s.id}"`);
      seenIds.add(s.id);
    }
    if (!s.trigger || typeof s.trigger !== 'object') {
      fail(`${where}: trigger must be an object`);
      return;
    }
    const { tool, args } = s.trigger;
    if (!tool || typeof tool !== 'string') {
      fail(`${where}: trigger.tool must be a non-empty string`);
      return;
    }
    if (!args || typeof args !== 'object') {
      fail(`${where}: trigger.args must be an object`);
      return;
    }

    // Per-tool allow-listing (security-infra constraint):
    if (tool === 'Write' || tool === 'Edit' || tool === 'Read') {
      const p = (args as { path?: unknown }).path;
      if (typeof p !== 'string' || p.startsWith('/') || p.includes('..')) {
        fail(`${where}: trigger.args.path must be a relative path with no ".." and no "/" prefix`);
      }
    } else if (tool === 'Bash') {
      const cmd = (args as { cmd?: unknown }).cmd;
      if (typeof cmd !== 'string') {
        fail(`${where}: trigger.args.cmd must be a string`);
      } else {
        const first = cmd.trim().split(/\s+/)[0];
        if (!BASH_ALLOWED_VERBS.has(first)) {
          fail(`${where}: trigger.args.cmd first token "${first}" not in allow-list ${[...BASH_ALLOWED_VERBS].join(', ')}`);
        }
      }
    } else if (tool === 'WebFetch') {
      const url = (args as { url?: unknown }).url;
      if (typeof url !== 'string' || !WEBFETCH_URL_RE.test(url)) {
        fail(`${where}: trigger.args.url must match ^http://127\\.0\\.0\\.1:<port>/`);
      }
    } else if (MCP_TOOL_RE.test(tool)) {
      // MCP tool calls must reference a vendored/stub server name; we treat
      // any value starting with the prefix "stub-" or "vendored-" as
      // schema-allowed. Anything else is rejected to prevent third-party
      // supply-chain surface on every PR.
      const srv = (args as { server?: unknown }).server;
      if (typeof srv !== 'string' || !(srv.startsWith('stub-') || srv.startsWith('vendored-'))) {
        fail(`${where}: MCP trigger.args.server must start with "stub-" or "vendored-"`);
      }
    }

    if (typeof s.expectsPrompt !== 'boolean') {
      fail(`${where}: expectsPrompt must be boolean`);
    }
    if (s.expectsPrompt) {
      if (typeof s.promptTextSnippet !== 'string' || s.promptTextSnippet.length < 20) {
        fail(`${where}: promptTextSnippet must be a string of ≥ 20 chars when expectsPrompt is true`);
      }
    }
    if (!Array.isArray(s.flags)) {
      fail(`${where}: flags must be an array of strings`);
    }
  });
}

if (errors.length > 0) {
  console.error('Fixture validation FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `Fixture OK: ${fixture.scenarios.length} scenarios, claude version ${fixture.claudeVersion}.`,
);
if (fixture.scenarios.length === 0) {
  console.log(
    'NOTE: scenarios array is empty (pending enumeration with authenticated claude). Schema is valid; populate at substrate-build acceptance pass.',
  );
}
