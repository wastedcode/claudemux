import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { ReplTimeout } from "../errors.js";
import { CLASSIFIER_BOTTOM_N } from "../session/constants.js";
import { formatSessionLabel } from "../session/ref.js";
import { classify } from "../state/classifier.js";
import type { IdleState, ReadyOpts } from "../types.js";
import { sleep } from "../util/sleep.js";
import { paneFingerprint, readSendBaseline } from "./baseline.js";
import { type StabilizeResult, stabilize as defaultStabilize } from "./stabilize.js";

/** Default total budget for `wait()`: 5 minutes. */
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/** How long pane text must be unchanged before declaring "idle." */
const IDLE_STABLE_WINDOW_MS = 250;

/** Polling cadence while waiting. */
const POLL_MS = 150;

interface WaitDeps {
  stabilize: typeof defaultStabilize;
}

/**
 * Wait until the classifier reports an {@link IdleState}.
 *
 * v0.0.1 is **state-mode only** — `pattern` and `debounce` modes are
 * deferred to v0.1.
 *
 * **Transition-aware, not snapshot-based.** `send()` returns soon after the
 * bytes are delivered; the agent then clears its input box to an *empty*
 * ready prompt **before** it starts working (verified ~≤200ms gap against
 * claude 2.1.153). A snapshot `wait()` would read that momentarily-empty
 * prompt as `idle` and return "done" before the turn even started, recording
 * the previous answer as this turn's result. So `wait()` will not accept
 * `idle` until it has *armed* — observed evidence that this turn actually
 * ran — and only then does a *return* to idle (held stable for
 * {@link IDLE_STABLE_WINDOW_MS}, which guards against returning between tokens
 * of a stream) count as the turn completing. See
 * `engineer/wiki/wait-needs-a-transition-not-a-snapshot`.
 *
 * Two independent arm signals, so both the in-process and the stateless-CLI
 * paths are covered:
 *   1. **Observed non-idle** (`working`/`unknown`). A real turn is `working`
 *      (`esc to interrupt`) for far longer than one poll, so an in-process
 *      `wait()` started right after `send` reliably catches it.
 *   2. **Divergence from the post-submit baseline.** `send` records a
 *      fingerprint of the post-submit pane (box cleared, answer not yet
 *      landed — see `io/baseline.ts`); `wait` arms when the live pane differs
 *      from it. This is what saves the stateless CLI, where `send` and `wait`
 *      are separate processes and a *fast* turn can be back to idle before
 *      `wait`'s first poll — signal (1) is never seen, so `wait` would hang
 *      to `ReplTimeout` without this (bug 8a500a52). Crucially the baseline is
 *      the *post-submit* frame, so during the dangerous pre-answer window the
 *      live pane *equals* it → no divergence → no premature return. (A *pre*-
 *      send baseline would diverge the instant the submit echoed and return
 *      early — the failure dogfooding caught against live claude 2.1.153.)
 *
 * `dialog` / `permission-prompt` are *actionable* states and return
 * immediately — no transition required (they are not "the previous idle").
 *
 * @throws `ReplTimeout` if `opts.timeoutMs` (default 300_000) elapses
 *   before the turn completes.
 */
export async function waitForState(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  opts: ReadyOpts,
  deps: WaitDeps = { stabilize: defaultStabilize },
): Promise<IdleState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const start = Date.now();
  // "armed" = we have evidence this turn ran (the pane left idle, or it has
  // diverged from the post-submit baseline). We will not accept a *return* to
  // idle as "turn complete" until this holds.
  let armed = false;
  // The post-submit fingerprint left by `send`, if any. Read once: `send`
  // already completed before this `wait` (sequential, even cross-process).
  const baseline = await readSendBaseline(backend, ref);

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new ReplTimeout(formatSessionLabel(ref), timeoutMs);
    }

    const text = await backend.capture(ref, { lines: CLASSIFIER_BOTTOM_N });
    const state = classify(text, agent.rules);

    // Dialog and permission-prompt return immediately — they are actionable
    // states and we don't want to wait for them to "stabilize."
    if (state === "dialog") return "dialog";
    if (state === "permission-prompt") return "permission-prompt";

    // Arm signal (1): the first non-idle observation (the agent started working).
    if (state !== "idle") armed = true;
    // Arm signal (2): the live pane has diverged from the post-submit baseline
    // — the turn produced output even though this (stateless) wait never saw a
    // working frame. Equal-to-baseline means we're still in the pre-answer
    // window, so we must NOT arm (that is the premature-idle guard).
    else if (baseline !== undefined && paneFingerprint(text) !== baseline) armed = true;

    if (state === "idle" && armed) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const r: StabilizeResult = await deps.stabilize(backend, ref, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: IDLE_STABLE_WINDOW_MS,
        pollMs: POLL_MS,
        timeoutMs: Math.min(remaining, IDLE_STABLE_WINDOW_MS * 4),
      });
      if (r.stable && agent.rules.idle(r.text)) return "idle";
      continue;
    }

    // working / unknown / (idle but not yet armed: the stale prompt) → poll on.
    await sleep(POLL_MS);
  }
}
