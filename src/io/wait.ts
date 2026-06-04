import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { assembleBelief } from "../observe/observer.js";
import { CLASSIFIER_BOTTOM_N, CLASSIFIER_CAPTURE } from "../session/constants.js";
import { classify } from "../state/classifier.js";
import type { ReadyOpts, TurnOutcome } from "../types.js";
import { sleep } from "../util/sleep.js";
import { paneFingerprint, readSendBaseline } from "./baseline.js";
import { type StabilizeResult, stabilize as defaultStabilize } from "./stabilize.js";

/** Default total budget for `wait()`: 5 minutes. */
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/** How long the idle box must hold steady before "completed" (guards mid-stream returns). */
const IDLE_STABLE_WINDOW_MS = 250;

/** Polling cadence while waiting. */
const POLL_MS = 150;

/**
 * No-progress window after which a *blind* wait (no hook signal, pane shows
 * nothing recognizable) gives up early as `budget-exceeded{idle}` instead of
 * burning the whole wall-clock budget on a wedged turn. Conservative so a model
 * that legitimately thinks for a while (a `working` pane, or a tool in flight)
 * is never mistaken for stuck.
 */
const STUCK_MS = 30_000;

interface WaitDeps {
  stabilize: typeof defaultStabilize;
}

/**
 * Wait until the turn reaches a terminal {@link TurnOutcome} — the **compound
 * owner** of "the turn stopped, and why." It composes two atomic sub-owners and
 * re-derives neither's internals:
 *   - the **observe** sub-owner ({@link assembleBelief}: hooks + transcript +
 *     pane) yields `completed` / `awaiting` / `aborted`;
 *   - the **policy** sub-owner (the patience budget, here) yields
 *     `budget-exceeded` — `reason:"max"` (wall-clock) vs `"idle"` (wedged).
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
 * (no settle) — they are not "the previous idle." Never throws on timeout: a
 * budget overrun is a returned `budget-exceeded`, not an exception.
 */
export async function waitForOutcome(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  paths: { rendezvousPath?: string; transcriptPath?: string },
  opts: ReadyOpts,
  deps: WaitDeps = { stabilize: defaultStabilize },
): Promise<TurnOutcome> {
  const budget = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
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

    // ── observe sub-owner: form the one belief ──────────────────────────────
    // A capture failure means the session/server is gone (terminal) — let the
    // typed SessionGone/BackendUnreachable propagate rather than poll a corpse.
    const paneText = await backend.capture(ref, CLASSIFIER_CAPTURE);
    const belief = assembleBelief({
      agent,
      ...(paths.rendezvousPath === undefined ? {} : { rendezvousPath: paths.rendezvousPath }),
      ...(paths.transcriptPath === undefined ? {} : { transcriptPath: paths.transcriptPath }),
      pane: {
        state: classify(paneText, agent.rules),
        interrupted: agent.rules.interrupted?.(paneText) ?? false,
      },
    });

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
    const hookDone = belief.lastStopAt !== undefined && belief.lastStopAt >= start;
    if (belief.state !== "idle") armed = true;
    else if (baseline !== undefined && paneFingerprint(paneText) !== baseline) armed = true;
    if (belief.state === "idle" && (hookDone || armed)) {
      const remaining = Math.max(0, budget - (now - start));
      const r: StabilizeResult = await deps.stabilize(backend, ref, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: IDLE_STABLE_WINDOW_MS,
        pollMs: POLL_MS,
        timeoutMs: Math.min(remaining, IDLE_STABLE_WINDOW_MS * 4),
        ansi: true,
      });
      if (r.stable && agent.rules.idle(r.text)) return { kind: "completed" };
    }

    // ── policy sub-owner: budget / stuck ────────────────────────────────────
    if (now - start > budget) {
      // Recent progress ⇒ ran out of wall-clock ("max"); otherwise wedged ("idle").
      return { kind: "budget-exceeded", reason: now - lastProgressAt < STUCK_MS ? "max" : "idle" };
    }
    // Early stuck: blind (no hook lifecycle, pane unrecognized) and nothing has
    // changed for the stuck window — fail fast rather than burn the full budget.
    if (belief.state === "unknown" && !belief.toolInFlight && now - lastProgressAt > STUCK_MS) {
      return { kind: "budget-exceeded", reason: "idle" };
    }

    await sleep(POLL_MS);
  }
}
