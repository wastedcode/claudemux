import type { Backend, SessionRef } from "../backends/types.js";
import type { Belief } from "../observe/observer.js";
import { CLASSIFIER_BOTTOM_N } from "../session/constants.js";
import type { ReadyOpts, TurnOutcome } from "../types.js";
import { sleep } from "../util/sleep.js";
import { paneFingerprint, readSendBaseline } from "./baseline.js";
import type { StabilizeResult, stabilize as defaultStabilize } from "./stabilize.js";

/** How long the idle box must hold steady before "completed" (guards mid-stream returns). */
const IDLE_STABLE_WINDOW_MS = 250;

/** Polling cadence while waiting. */
const POLL_MS = 150;

interface WaitDeps {
  stabilize: typeof defaultStabilize;
}

/**
 * Reads the fused {@link Belief} for one poll, plus the raw pane text the
 * fingerprint/arming need. Injected by the handle so `wait()` shares the handle's
 * **incremental** observer (bounded per-poll reads) and never re-reads files or
 * touches the agent itself.
 */
export type BeliefReader = () => Promise<{ belief: Belief; paneText: string }>;

/**
 * Wait until the turn reaches a terminal {@link TurnOutcome} — the **compound
 * owner** of "the turn stopped, and why." It composes two atomic sub-owners and
 * re-derives neither's internals:
 *   - the **observe** sub-owner (the injected {@link BeliefReader}: hooks +
 *     transcript + pane) yields `completed` / `awaiting` / `aborted`;
 *   - the **policy** sub-owner — the CONSUMER's patience ({@link ReadyOpts}) —
 *     yields `budget-exceeded`: `reason:"max"` (wall-clock `maxMs`) vs `"idle"`
 *     (no progress for `idleMs`). The library owns NO patience: with neither
 *     bound supplied, `wait()` blocks until a terminal belief (it never invents a
 *     deadline; "time is the policy's").
 *
 * **Completion is hook-first, flush-safe.** The `stop` hook edge is the reliable
 * "turn ended" trigger; but the edge fires ~100ms before the transcript flushes
 * the reply, so `completed` is only declared once the pane has *also* settled to
 * a stable idle box — which trails the flush — guaranteeing a following
 * `messagesSince(cursor)` is race-free. With hooks off there is no edge, so a
 * pane-idle that has *armed* (left idle, or diverged from the post-submit
 * baseline) is the completion signal instead — the stateless-CLI fast-turn path
 * (bug 8a500a52). Either way, the previous turn's lingering idle never counts:
 * `completed` requires a `stop` edge newer than this wait, or a fresh arm.
 *
 * `dialog`/`permission-prompt`/`aborted` are actionable and return immediately
 * (no settle). Never throws on timeout: a budget overrun is a returned
 * `budget-exceeded`, not an exception. (A capture failure inside the reader DOES
 * propagate — a gone session is terminal, not a budget matter.)
 */
export async function waitForOutcome(
  backend: Backend,
  ref: SessionRef,
  opts: ReadyOpts,
  // Both required — the handle (and tests) always inject them. A throwing default
  // would just move a programmer error from compile time to runtime.
  deps: WaitDeps,
  readBelief: BeliefReader,
): Promise<TurnOutcome> {
  // The CONSUMER's patience — both optional, NO library default. `timeoutMs` is
  // a deprecated alias for `maxMs`. With neither set, `wait()` owns no deadline
  // and blocks until a terminal belief ("time is the policy's").
  const maxMs = opts.maxMs ?? opts.timeoutMs;
  const idleMs = opts.idleMs;
  const start = Date.now();
  // "armed" = evidence this turn ran (pane left idle, or diverged from the
  // post-submit baseline) — needed for the hooks-off path; the hook `stop` edge
  // makes it moot when hooks are healthy.
  let armed = false;
  let lastProgressAt = start;
  let lastSignature = "";
  const baseline = await readSendBaseline(backend, ref);

  while (true) {
    const now = Date.now();

    // ── observe sub-owner: the one belief (incremental, via the handle) ──────
    const { belief, paneText } = await readBelief();

    // ── terminal verdicts the observe sub-owner already settles ─────────────
    if (belief.state === "dialog") return { kind: "awaiting", on: "dialog" };
    if (belief.state === "permission-prompt") return { kind: "awaiting", on: "permission-prompt" };
    if (belief.interrupted) return { kind: "aborted" };

    // ── progress heartbeat (drives stuck detection) ─────────────────────────
    const signature = `${belief.lastActivityAt ?? 0}|${belief.transcriptCount}|${paneFingerprint(paneText)}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = now;
    }

    // ── completion: a hook done-edge OR an armed pane-idle, confirmed settled ─
    // KNOWN LIMITATION (F42, single-host assumption): `lastStopAt` is the hook's
    // own clock (`date +%s.%N` on the SESSION's host); `start` is the consumer's
    // `Date.now()`. They agree only on one host / one clock. Under cross-host
    // clock skew (a distributed deployment driving a remote agent), a real `stop`
    // can read as before/after this wait → completion mis-fires; the pane-idle arm
    // path still recovers it, but the reliable hook trigger is degraded. The fix
    // is to baseline the stop-edge ORDER/count at wait-start instead of comparing
    // wall-clocks (the S9 pattern); deferred until a distributed consumer needs it.
    const hookDone = belief.lastStopAt !== undefined && belief.lastStopAt >= start;
    if (belief.state !== "idle") armed = true;
    else if (baseline !== undefined && paneFingerprint(paneText) !== baseline) armed = true;
    if (belief.state === "idle" && (hookDone || armed)) {
      // The stabilize debounce is a transport detail (legitimately the library's,
      // per the read/write-split RFC); cap it by any remaining wall-clock budget.
      const remaining =
        maxMs === undefined ? IDLE_STABLE_WINDOW_MS * 4 : Math.max(0, maxMs - (now - start));
      const r: StabilizeResult = await deps.stabilize(backend, ref, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: IDLE_STABLE_WINDOW_MS,
        pollMs: POLL_MS,
        timeoutMs: Math.min(remaining, IDLE_STABLE_WINDOW_MS * 4),
        ansi: true,
      });
      // Re-confirm via the belief (the one owner), not raw pane rules.
      if (r.stable && (await readBelief()).belief.state === "idle") return { kind: "completed" };
    }

    // ── policy sub-owner: the CONSUMER's patience (the library owns none) ─────
    // Wall-clock cap.
    if (maxMs !== undefined && now - start > maxMs)
      return { kind: "budget-exceeded", reason: "max" };
    // No-progress cap. Gated on `state==="unknown" && !toolInFlight` so it means
    // "stuck too long," never "still working too long": a `working` pane (the live
    // `esc to interrupt` spinner) or a tool in flight is never counted as idle,
    // and the heartbeat keys on the pane fingerprint so a still-animating spinner
    // keeps resetting it even when a frame classifies `unknown`. The THRESHOLD is
    // the consumer's (`idleMs`); the library only distinguishes stuck-from-working.
    if (
      idleMs !== undefined &&
      belief.state === "unknown" &&
      !belief.toolInFlight &&
      now - lastProgressAt > idleMs
    ) {
      return { kind: "budget-exceeded", reason: "idle" };
    }

    await sleep(POLL_MS);
  }
}
