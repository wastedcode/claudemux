import type { Backend, SessionRef } from "../backends/types.js";
import { sleep } from "../util/sleep.js";

/**
 * "Pane unchanged for windowMs" probe. Captures the bottom-N pane region at
 * `pollMs` intervals; returns `{ stable: true, text }` once the captured
 * text has not changed across an entire `windowMs` window, or
 * `{ stable: false, reason: "timeout" }` once `timeoutMs` elapses.
 *
 * Shared by `session/boot.ts` (post-dialog advancement check) and `io/wait.ts`
 * (idle stabilization).
 */
export interface StabilizeResult {
  stable: boolean;
  text: string;
  reason?: "timeout";
}

export async function stabilize(
  backend: Backend,
  ref: SessionRef,
  opts: {
    /** Bottom-N lines to capture. */
    lines: number;
    /** How long the pane must stay identical to declare stable. */
    windowMs: number;
    /** Capture interval. */
    pollMs: number;
    /** Overall budget; returns `{ stable: false, reason: "timeout" }` past it. */
    timeoutMs: number;
    /** Capture with ANSI styling on (so the returned `text` feeds idle checks). */
    ansi?: boolean;
  },
): Promise<StabilizeResult> {
  const start = Date.now();
  const capOpts = { lines: opts.lines, ...(opts.ansi === true ? { ansi: true } : {}) };
  let lastText = await backend.capture(ref, capOpts);
  let unchangedSince = Date.now();

  while (Date.now() - start < opts.timeoutMs) {
    if (Date.now() - unchangedSince >= opts.windowMs) {
      return { stable: true, text: lastText };
    }
    await sleep(opts.pollMs);
    const now = await backend.capture(ref, capOpts);
    if (now !== lastText) {
      lastText = now;
      unchangedSince = Date.now();
    }
  }
  return { stable: false, text: lastText, reason: "timeout" };
}
