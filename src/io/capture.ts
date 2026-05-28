import type { Backend } from "../backends/types.js";

/**
 * Pure pass-through to `Backend.capture`. Lives in `src/io/` because the
 * top-level public verbs ARE the io layer; the backend is below it. Future
 * non-tmux backends implement the same `capture` shape, so the wrapper
 * stays trivial.
 *
 * @param opts.ansi  preserve escape sequences when `true`.
 * @param opts.lines bottom-N visible lines (default: full visible region).
 */
export function captureOnce(
  backend: Backend,
  target: string,
  opts?: { ansi?: boolean; lines?: number },
): Promise<string> {
  return backend.capture(target, opts);
}
