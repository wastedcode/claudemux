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
 * Tolerance (ms) for the mtime comparison. `mtimeMs` is a float derived from
 * the stat's nanosecond `mtim`; at epoch magnitude (~1.78e12) its ULP is
 * ~2e-4 ms, and a `utimes` restore round-trips with a few-µs drift — so exact
 * `!==` is unsound and false-positives on filesystems that record sub-second
 * mtimes (CI), where a test that restores the sentinel can't reproduce the
 * exact float. A real leak is a genuine write that advances mtime to wall-clock
 * "now" — at least milliseconds, in practice seconds (claude booting + writing
 * config) after the sentinel was planted — so 1 ms cleanly separates jitter
 * (~µs) from a leak (≫ ms) without weakening the trip-wire.
 */
const MTIME_TOLERANCE_MS = 1;

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
  if (Math.abs(nowMtimeMs - sentinel.mtimeMs) >= MTIME_TOLERANCE_MS) {
    return `sentinel mtime moved: ${sentinel.path} (${sentinel.mtimeMs} → ${nowMtimeMs}) — sandbox HOME leaked into the real ~/.claude/`;
  }
  return null;
}
