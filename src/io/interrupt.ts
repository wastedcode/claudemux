import type { Backend, SessionRef } from "../backends/types.js";
import { sleep } from "../util/sleep.js";

/**
 * Fixed best-effort settle after firing ESC, mirroring `send`'s post-submit
 * window (`io/send.ts` / `io/baseline.ts`, ~the time for the input box to
 * clear, typically ≤250ms). claude does not tear down the `"esc to interrupt"`
 * affordance instantaneously; without this beat an *immediate* following
 * `state()` can read the mid-interrupt frame and still report `working`.
 *
 * This is a FIXED delay, not a poll-until-not-working loop — "did the interrupt
 * take" retry/backoff is the consumer's job. It never fails the interrupt.
 */
const INTERRUPT_SETTLE_MS = 250;

/**
 * Fire a single `Escape` at the pane — claude's own documented interrupt key
 * (the classifier detects `working` by the literal `"esc to interrupt"`
 * affordance, `agents/claude.ts`). ESC is already in `SendPayload`'s key union
 * (`backends/types.ts`) and `sendKey` already sends it, so there is no backend
 * change.
 *
 * ESC is sent **unconditionally** — no state-check guard. A guard would bake
 * policy into the substrate and open a TOCTOU race (state read, then ESC, with
 * the agent free to change state in between). ESC on an idle claude is harmless
 * (it clears the input box). Gating on `state()` is the consumer's call. This
 * is a mechanism, not a policy
 * (`brain/decisions/0013-mechanism-not-policy-substrate-boundary.md`).
 *
 * That consumer-side gate is also not atomic with the ESC: a turn can finish
 * between a `state()===working` read and the ESC landing — most easily across
 * separate CLI processes (a short turn completes in the gap), so the ESC hits
 * an already-idle agent. That is a harmless no-op, not a failure; a consumer
 * that needs the interrupt to catch a turn should read `state()` and call this
 * in one tight in-process sequence, not trust a stale prior-process reading.
 *
 * Blocks on **write delivery** plus a brief fixed settle ({@link
 * INTERRUPT_SETTLE_MS}); it guarantees ESC was delivered, NOT that an in-flight
 * abort has fully completed. This verb does exactly one named action — stop the
 * turn — and nothing more (`brain/decisions/0013`, "a primitive does exactly the
 * keystroke it names").
 *
 * **After interrupt(), claude does NOT return to a clean idle prompt.** It
 * restores the interrupted message back into the composer, and the classifier
 * reads that frame as `unknown` (never `idle`, never `working`). Two
 * consequences the consumer must know:
 *   - `wait()` after interrupt() resolves `{ kind: "aborted" }` immediately (the
 *     handle records the interrupt authoritatively) — it does NOT hang waiting for
 *     an idle that won't come.
 *   - Do **not** naively `send()` a replacement after interrupt(): `send`
 *     pastes into the *non-empty* composer (the restored message), so the
 *     submission is the two texts concatenated. For a clean "interrupt and
 *     replace" the composer must first be cleared to empty. claude's only
 *     substrate-reachable composer clear is repeated ESC (its "Esc again to
 *     clear" ladder), so the recipe is consumer-composed and claude-specific —
 *     see the README "Interrupting a working agent" note. It is deliberately
 *     NOT bundled into this agent-agnostic verb.
 */
export async function interruptOnce(backend: Backend, ref: SessionRef): Promise<void> {
  await backend.send(ref, { kind: "key", key: "Escape" });
  await sleep(INTERRUPT_SETTLE_MS);
}
