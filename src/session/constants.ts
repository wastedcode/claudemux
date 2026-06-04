/**
 * The default namespace prefix used by `create`, `exists`, `kill`, `list`
 * when the caller doesn't pass one. Two consumers on the same machine
 * pick distinct namespaces to coexist on one shared backend server.
 */
export const DEFAULT_NAMESPACE = "claudemux";

/**
 * Pane height the substrate creates sessions at (`new-session -y`). The
 * classifier never sees more than this many rows, because `capture-pane -p`
 * returns only the visible region (never scrollback) — so a stray match in
 * history is impossible by construction, regardless of the scan window.
 *
 * If this changes, {@link CLASSIFIER_BOTTOM_N} should track it.
 */
export const PANE_HEIGHT = 40;

/**
 * How many lines from the bottom of the visible region the classifier scans.
 * Set to the full pane height ({@link PANE_HEIGHT}): the visible region is
 * already only {@link PANE_HEIGHT} rows, so `slice(-CLASSIFIER_BOTTOM_N)` is
 * the whole capture — there is no larger buffer to trim. (An earlier value of
 * 50 implied a 50-line scan that a 40-row pane can never produce; this ties
 * the constant to the real cap.)
 *
 * Shared by `session/boot.ts`, `session/handle.ts`, and `io/wait.ts` so a
 * dialog/idle pattern is detected consistently across the boot and wait paths.
 */
export const CLASSIFIER_BOTTOM_N = PANE_HEIGHT;

/**
 * Capture options for any **readiness / classifier** read — bottom-N rows with
 * ANSI styling **on** (`capture -e`). The styling is load-bearing: the agent's
 * idle check separates the dim ghost-placeholder hint shown in an empty input
 * box from a real (normal-intensity) draft, which is impossible on plain text
 * (see claude `isReady`). Substring predicates (dialog headers, working) strip
 * SGR first, so ANSI-on is safe for them too.
 *
 * Every readiness read uses this one shape so the `send→wait` pane fingerprints
 * stay self-consistent (all ANSI). The *public* `capture()` is unaffected — it
 * defaults to plain, user-facing text.
 */
export const CLASSIFIER_CAPTURE = { lines: CLASSIFIER_BOTTOM_N, ansi: true } as const;

/**
 * Backend-neutral session-meta key under which {@link create} caches the
 * agent's conversation id, and {@link adopt} reads it back. The id is a
 * *locator* (it names a conversation and its transcript), not a secret; the
 * real boundary is who can reach the backend's per-session store — today a
 * per-process private tmux socket. If claudemux ever multi-tenants onto a
 * *shared* tmux server, a co-tenant could enumerate every such key and locate
 * others' transcripts; revisit the store's trust model then.
 *
 * One authoritative spelling shared by the writer and the reader so they can
 * never drift apart.
 */
export const AGENT_SESSION_ID_META_KEY = "agent-session-id";
