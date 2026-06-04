import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { CLASSIFIER_CAPTURE } from "../session/constants.js";
import { captureSendBaseline, writeSendBaseline } from "./baseline.js";

/**
 * Deliver `text` as one logical user turn: a `paste` of the body, then a
 * separate `Enter`. The two backend calls happen sequentially — there is
 * no path by which the paste body can self-submit.
 *
 * Blocks on **write delivery** (and a short post-submit settle, below), not on
 * the agent's response. Callers who want to know when the agent is done should
 * call `wait()` next.
 *
 * **Post-submit baseline.** After delivery, `send` records a fingerprint of
 * the post-submit pane (see {@link captureSendBaseline}) under a session-scoped
 * key. This lets a *stateless* `wait()` — the CLI reattaches in a fresh process
 * — detect a turn that completed before its first poll, instead of hanging to
 * `ReplTimeout` (bug 8a500a52). It adds a brief settle (~the time for the input
 * box to clear, typically ≤250ms) to `send`; it is best-effort and never fails
 * the send.
 *
 * @remarks
 * The two-call sequence (paste-then-Enter) is load-bearing per
 * `docs/decisions/0001-tmux-paste-mechanism.md` — bracketed paste lets the
 * receiver distinguish typed `\n`
 * (submit) from pasted `\n` (literal newline). Folding submission into the
 * paste body would re-introduce the per-line-submit failure mode.
 */
export async function sendOnce(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  text: string,
): Promise<void> {
  // Pre-send pane: the baseline poll uses it to skip the previous idle and
  // capture the *post-submit* frame instead. Best-effort — if it fails, the
  // baseline is simply not recorded and wait falls back to working-arm.
  let pre: string | undefined;
  try {
    pre = await backend.capture(ref, CLASSIFIER_CAPTURE);
  } catch {
    pre = undefined;
  }

  await backend.send(ref, { kind: "paste", text });
  await backend.send(ref, { kind: "key", key: "Enter" });

  // Always (over)write — this turn's baseline replaces any prior turn's, and
  // an empty value clears it when we couldn't establish a fresh one (e.g. the
  // pre-send capture failed). Otherwise a later wait could arm on a *stale*
  // fingerprint and return the previous turn's idle. Empty == "no baseline",
  // so wait falls back to arming on an observed working frame.
  const fingerprint = await captureSendBaseline(backend, agent, ref, pre);
  await writeSendBaseline(backend, ref, fingerprint ?? "");
}

/**
 * Re-fire the submit key (Enter) alone — the recovery for a **lost submit**: the
 * paste reached the composer but the Enter keystroke didn't register, so the turn
 * sits there un-submitted and no user record is ever written.
 *
 * Critically it does NOT re-paste the body. A re-`send()` would paste the text a
 * second time and submit `texttext`; pressing Enter only submits whatever the
 * composer already holds, so the recovery can never duplicate content. On an
 * already-empty composer (a genuine non-delivery, not a lost Enter) it is a
 * harmless no-op — the agent ignores an empty submit.
 *
 * Mechanism, not policy: this owns only the keystroke. The caller decides *when*
 * to use it (its own user record never appeared AND the message wasn't queued)
 * and re-checks delivery afterward — this does not poll or confirm.
 */
export async function submitOnce(backend: Backend, ref: SessionRef): Promise<void> {
  await backend.send(ref, { kind: "key", key: "Enter" });
}
