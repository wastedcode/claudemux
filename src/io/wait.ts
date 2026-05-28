import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { ReplTimeout } from "../errors.js";
import { CLASSIFIER_BOTTOM_N } from "../session/constants.js";
import { formatSessionLabel } from "../session/ref.js";
import { classify } from "../state/classifier.js";
import type { IdleState, ReadyOpts } from "../types.js";
import { sleep } from "../util/sleep.js";
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
 * **Transition-aware, not snapshot-based.** `send()` returns the instant the
 * bytes are delivered; the agent has render latency before it clears its
 * ready prompt to start working. A snapshot `wait()` would read that *stale*
 * idle prompt — the *previous* turn's — classify `idle`, and return "done"
 * before the turn even started, recording the previous answer as this turn's
 * result. So `wait()` will not accept `idle` until it has first observed the
 * pane **leave** idle: either a non-idle state (`working`/`unknown`) or — when
 * the caller supplies the pre-send `baseline` — any change from it. Only then
 * does a *return* to idle (held stable for {@link IDLE_STABLE_WINDOW_MS},
 * which guards against returning between tokens of a stream) count as the
 * turn completing. See `engineer/wiki/wait-needs-a-transition-not-a-snapshot`.
 *
 * `dialog` / `permission-prompt` are *actionable* states and return
 * immediately — no transition required (they are not "the previous idle").
 *
 * @param baseline - The pre-send pane snapshot (bottom-N), threaded by the
 *   handle. When present, a pane that *differs* from it also arms the wait —
 *   this covers an instant turn that produces new output without an
 *   observable `working` frame. When absent (e.g. `wait()` with no prior
 *   `send`), the wait arms only on observing a non-idle state.
 * @throws `ReplTimeout` if `opts.timeoutMs` (default 300_000) elapses
 *   before the turn completes.
 */
export async function waitForState(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  opts: ReadyOpts,
  deps: WaitDeps = { stabilize: defaultStabilize },
  baseline?: string,
): Promise<IdleState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const start = Date.now();
  // "armed" = the pane has been observed leaving the post-send idle. We will
  // not accept a *return* to idle as "turn complete" until this is true.
  let armed = false;

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

    // Arm on the first observed transition away from the post-send idle:
    // any non-idle observation, or any change from the supplied baseline.
    if (!armed && (state !== "idle" || (baseline !== undefined && text !== baseline))) {
      armed = true;
    }

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
