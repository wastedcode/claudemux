import type { AgentDef } from "../agents/types.js";
import type { Backend } from "../backends/types.js";
import { ReplTimeout } from "../errors.js";
import { classify } from "../state/classifier.js";
import type { IdleState, ReadyOpts } from "../types.js";
import { type StabilizeResult, stabilize as defaultStabilize } from "./stabilize.js";

/** Default total budget for `wait()`: 5 minutes. */
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

/**
 * Bottom-N lines the classifier scans. Same value as `session/boot.ts` so a
 * dialog mid-stream is detected consistently.
 */
const CLASSIFIER_BOTTOM_N = 50;

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
 * deferred to v0.1. The state-mode contract: returns as soon as state
 * settles to `idle`, `permission-prompt`, or `dialog`. `idle` additionally
 * requires the pane to be unchanged for {@link IDLE_STABLE_WINDOW_MS} (the
 * stabilization window from `io/stabilize.ts`) to avoid returning between
 * tokens of a streaming turn.
 *
 * @throws `ReplTimeout` if `opts.timeoutMs` (default 300_000) elapses
 *   before the state settles.
 */
export async function waitForState(
  backend: Backend,
  agent: AgentDef,
  target: string,
  opts: ReadyOpts,
  deps: WaitDeps = { stabilize: defaultStabilize },
): Promise<IdleState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new ReplTimeout(target, timeoutMs);
    }

    const text = await backend.capture(target, { lines: CLASSIFIER_BOTTOM_N });
    const state = classify(text, agent.rules);

    // Dialog and permission-prompt return immediately — they are actionable
    // states and we don't want to wait for them to "stabilize."
    if (state === "dialog") return "dialog";
    if (state === "permission-prompt") return "permission-prompt";

    if (state === "idle") {
      // Confirm idle by holding the pane stable for the stabilization window.
      // Streaming output mid-turn shouldn't false-positive as idle.
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const r: StabilizeResult = await deps.stabilize(backend, target, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: IDLE_STABLE_WINDOW_MS,
        pollMs: POLL_MS,
        timeoutMs: Math.min(remaining, IDLE_STABLE_WINDOW_MS * 4),
      });
      if (r.stable && agent.rules.idle(r.text)) return "idle";
      // Pane changed — fall through and re-classify.
      continue;
    }

    // working / unknown → keep polling.
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}
