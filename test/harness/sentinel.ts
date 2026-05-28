import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tracks the mtime of a "do-not-touch" sentinel file under the **real**
 * `~/.claude/`. Tests that accidentally leak out of their sandbox HOME and
 * write to the real one will move this sentinel; the post-test assertion
 * catches the leak loudly.
 *
 * Belt-and-braces — the sandbox HOME is the primary guarantee. The
 * sentinel is the cheap defensive trip-wire on top of it.
 */
export interface Sentinel {
  /** Absolute path of the sentinel file. */
  readonly path: string;
  /** Snapshotted mtime in milliseconds. */
  readonly mtimeMs: number;
}

/**
 * Plant the sentinel (creating `~/.claude/` first if it doesn't exist) and
 * record its mtime. Idempotent — a sentinel that already exists is reused
 * with its current mtime.
 */
export function plantSentinel(): Sentinel {
  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const path = join(claudeDir, ".do-not-touch-sentinel");
  if (!existsSync(path)) {
    writeFileSync(path, "claudemux test sentinel — do not touch\n");
  }
  const mtimeMs = statSync(path).mtimeMs;
  return { path, mtimeMs };
}

/**
 * Verify the sentinel's mtime is unchanged. Returns `null` on success,
 * or a description of the leak on failure. The test asserts on the return
 * value so the assertion failure surfaces the offending test by name.
 */
export function verifySentinel(sentinel: Sentinel): string | null {
  let nowMtimeMs: number;
  try {
    nowMtimeMs = statSync(sentinel.path).mtimeMs;
  } catch (err) {
    return `sentinel disappeared: ${sentinel.path} (${(err as Error).message})`;
  }
  if (nowMtimeMs !== sentinel.mtimeMs) {
    return `sentinel mtime moved: ${sentinel.path} (${sentinel.mtimeMs} → ${nowMtimeMs}) — sandbox HOME leaked into the real ~/.claude/`;
  }
  return null;
}
