/**
 * Promise-based sleep helper. `new Promise(res => setTimeout(res, ms))`
 * was repeated across boot.ts, wait.ts, stabilize.ts, and tests; this
 * gives the polling loops one place to evolve (e.g. swapping in an
 * AbortSignal later).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
