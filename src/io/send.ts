import type { Backend, SessionRef } from "../backends/types.js";

/**
 * Deliver `text` as one logical user turn: a `paste` of the body, then a
 * separate `Enter`. The two backend calls happen sequentially — there is
 * no path by which the paste body can self-submit.
 *
 * Blocks on **write delivery**, not on the agent's response. Callers who
 * want to know when the agent is done should call `wait()` next.
 *
 * @remarks
 * The two-call sequence (paste-then-Enter) is load-bearing per pre-build
 * research §1+2 — bracketed paste lets the receiver distinguish typed `\n`
 * (submit) from pasted `\n` (literal newline). Folding submission into the
 * paste body would re-introduce the per-line-submit failure mode.
 */
export async function sendOnce(backend: Backend, ref: SessionRef, text: string): Promise<void> {
  await backend.send(ref, { kind: "paste", text });
  await backend.send(ref, { kind: "key", key: "Enter" });
}
