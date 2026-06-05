import { createHash } from "node:crypto";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { CLASSIFIER_CAPTURE } from "../session/constants.js";
import { sleep } from "../util/sleep.js";

/**
 * The send→wait *baseline* — how a stateless `wait()` (the CLI reattaches in a
 * fresh process each invocation) tells a turn that already completed from the
 * previous turn's idle prompt.
 *
 * `wait()` is transition-aware: it will not accept `idle` as "turn complete"
 * until it has seen the pane *leave* idle. In-process that signal is an
 * observed `working` frame. But the CLI `send` and `wait` are separate
 * processes; for a fast turn the agent can be back to idle before the `wait`
 * process takes its first capture, so `wait` never observes `working` and
 * hangs to `ReplTimeout` (bug 8a500a52).
 *
 * The fix: `send` records a fingerprint of the **post-submit** pane — the
 * frame after the input box has cleared but *before* the agent's answer lands
 * — under a session-scoped key. A later `wait` arms when the live pane
 * *diverges* from that fingerprint. Capturing the post-submit frame (not the
 * pre-send one) is what keeps the previous turn's idle from counting as a
 * divergence: during the post-submit window the live pane *equals* the
 * baseline, so `wait` correctly keeps polling instead of returning early.
 */
export const SEND_BASELINE_KEY = "send-baseline";

/** Total budget for `send` to observe the post-submit frame before giving up. */
const BASELINE_CAPTURE_BUDGET_MS = 2_000;
/** Capture cadence while watching for the post-submit frame. */
const BASELINE_POLL_MS = 40;

/** Stable fingerprint of a bottom-N pane capture (sha256 hex — newline-safe). */
export function paneFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * After a `send`, capture the post-submit pane fingerprint: the first frame
 * that (a) differs from the pre-send pane `pre` and (b) is a settled idle box
 * or a working frame — i.e. the submit was accepted and the box cleared (or
 * the agent already started working), but *before* the answer completes.
 *
 * Returns `undefined` when no clean frame appears within budget, or when the
 * pre-send pane is unknown (without `pre` we cannot exclude the previous idle,
 * and a wrong baseline would re-introduce the premature-return race). In that
 * case `wait` falls back to arming on an observed `working` frame.
 */
export async function captureSendBaseline(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  pre: string | undefined,
): Promise<string | undefined> {
  if (pre === undefined) return undefined;
  const deadline = Date.now() + BASELINE_CAPTURE_BUDGET_MS;
  while (Date.now() < deadline) {
    let text: string;
    try {
      text = await backend.capture(ref, CLASSIFIER_CAPTURE);
    } catch {
      return undefined; // pane unreadable — let wait fall back to working-arm
    }
    // The first frame that has changed from the pre-send pane AND is either an
    // empty input box (the submit cleared it) or a working frame. This is
    // reached before the answer lands, so it never captures the completed-turn
    // pane (which would make a later wait see "no divergence" and hang).
    if (text !== pre && (agent.boot.isReady(text) || agent.rules.working(text))) {
      return paneFingerprint(text);
    }
    await sleep(BASELINE_POLL_MS);
  }
  return undefined;
}

/**
 * Read the persisted post-submit baseline fingerprint, if any. Best-effort:
 * returns `undefined` when unset or unreadable, so `wait` degrades to
 * observed-working arming rather than failing.
 */
export async function readSendBaseline(
  backend: Backend,
  ref: SessionRef,
): Promise<string | undefined> {
  try {
    const v = await backend.getSessionMeta(ref, SEND_BASELINE_KEY);
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the post-submit baseline fingerprint for a later `wait`. An empty
 * `fingerprint` clears the baseline (so `readSendBaseline` reports "unset") —
 * `send` uses that to drop a prior turn's stale fingerprint when it couldn't
 * establish a fresh one. Best-effort — a metadata write failure must never
 * fail the `send` (whose contract is byte delivery); `wait` then falls back to
 * observed-working arming.
 */
export async function writeSendBaseline(
  backend: Backend,
  ref: SessionRef,
  fingerprint: string,
): Promise<void> {
  try {
    await backend.setSessionMeta(ref, SEND_BASELINE_KEY, fingerprint);
  } catch {
    /* baseline is an optimization for cross-process wait; ignore */
  }
}
