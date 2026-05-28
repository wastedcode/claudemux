import type { Backend } from "../backends/types.js";

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
  target: string,
  opts: {
    /** Bottom-N lines to capture. */
    lines: number;
    /** How long the pane must stay identical to declare stable. */
    windowMs: number;
    /** Capture interval. */
    pollMs: number;
    /** Overall budget; returns `{ stable: false, reason: "timeout" }` past it. */
    timeoutMs: number;
  },
): Promise<StabilizeResult> {
  const start = Date.now();
  let lastText = await backend.capture(target, { lines: opts.lines });
  let unchangedSince = Date.now();

  while (Date.now() - start < opts.timeoutMs) {
    if (Date.now() - unchangedSince >= opts.windowMs) {
      return { stable: true, text: lastText };
    }
    await new Promise((res) => setTimeout(res, opts.pollMs));
    const now = await backend.capture(target, { lines: opts.lines });
    if (now !== lastText) {
      lastText = now;
      unchangedSince = Date.now();
    }
  }
  return { stable: false, text: lastText, reason: "timeout" };
}
