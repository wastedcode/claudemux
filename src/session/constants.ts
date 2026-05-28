/**
 * The default namespace prefix used by `create`, `exists`, `kill`, `list`
 * when the caller doesn't pass one. Two consumers on the same machine
 * pick distinct namespaces to coexist on one shared backend server.
 */
export const DEFAULT_NAMESPACE = "claudemux";

/**
 * How many lines from the bottom of the pane the classifier scans.
 * 50 covers claude's tallest dialog (theme picker, ~10 lines) with
 * comfortable headroom while preventing scrollback false-positives.
 *
 * Shared by `session/boot.ts`, `session/handle.ts`, and `io/wait.ts` so
 * a dialog/idle pattern mid-stream is detected consistently across the
 * boot path and the wait path.
 */
export const CLASSIFIER_BOTTOM_N = 50;
