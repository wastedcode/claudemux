import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The four XDG environment variables every well-behaved tool follows. Setting
 * `HOME` alone is not enough — see
 * `engineer/wiki/home-isolation-when-testing-against-claude`.
 */
export interface SandboxHome {
  /** Absolute path to the per-test temp HOME under `/tmp` (or system temp). */
  readonly home: string;
  /** XDG_CONFIG_HOME rerooted under `home`. */
  readonly xdgConfig: string;
  /** XDG_CACHE_HOME rerooted under `home`. */
  readonly xdgCache: string;
  /** XDG_DATA_HOME rerooted under `home`. */
  readonly xdgData: string;
  /** XDG_STATE_HOME rerooted under `home`. */
  readonly xdgState: string;
}

/**
 * Create a fresh sandbox HOME with all four XDG dirs pre-created. The
 * directory lives under the system temp dir (e.g. `/tmp/`); `cleanup()`
 * is safe to call multiple times and refuses to recurse-delete anything
 * outside the temp tree (defense against a future caller swapping paths).
 */
export function mintSandboxHome(): SandboxHome {
  const home = mkdtempSync(join(tmpdir(), "claudemux-test-"));
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const xdgData = join(home, ".local", "share");
  const xdgState = join(home, ".local", "state");
  for (const dir of [xdgConfig, xdgCache, xdgData, xdgState]) {
    mkdirSync(dir, { recursive: true });
  }
  return { home, xdgConfig, xdgCache, xdgData, xdgState };
}

/**
 * Remove a sandbox HOME tree. Refuses to remove anything outside `/tmp` or
 * the OS temp dir, so a misconfigured path (e.g. `/`) cannot delete real data.
 */
export function disposeSandboxHome(sandbox: SandboxHome): void {
  const root = sandbox.home;
  const sys = tmpdir();
  if (!root.startsWith(`${sys}/`) && !root.startsWith("/tmp/") && !root.startsWith("/var/tmp/")) {
    // Refuse — log nothing (no console.log policy); the test failing on its
    // own assertions will surface the misconfiguration.
    return;
  }
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
}
