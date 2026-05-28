import type { SessionRef } from "../backends/types.js";

/**
 * Format a {@link SessionRef} as a human-readable label for error messages
 * and observability. The substrate uses `<namespace>/<name>` — distinct
 * from any backend's internal encoding (the tmux backend, for example,
 * uses `<namespace>--<name>` as its target-name encoding internally).
 *
 * Putting the label format in one place means future changes (e.g. moving
 * to `<namespace>:<name>` to match the user's mental model) touch one
 * file, not five.
 */
export function formatSessionLabel(ref: SessionRef): string {
  return `${ref.namespace}/${ref.name}`;
}
