#!/usr/bin/env node
// Copy non-TS runtime assets (JSON fixtures) from src/ to dist/ after tsc.
// tsc does not copy non-TS files into outDir; this script handles them so the
// published `dist/**` tree is runnable end-to-end.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const assets = [["src/agents/permission-prompts.json", "dist/agents/permission-prompts.json"]];

for (const [from, to] of assets) {
  const src = join(repoRoot, from);
  const dst = join(repoRoot, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  process.stdout.write(`copied ${from} → ${to}\n`);
}
