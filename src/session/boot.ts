import type { AgentDef, BootDialog } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import {
  AgentExitedDuringBoot,
  BackendUnreachable,
  DialogStuck,
  LoginRequired,
  ReplTimeout,
  WorkspaceUntrusted,
} from "../errors.js";
import { stabilize } from "../io/stabilize.js";
import { sleep } from "../util/sleep.js";
import { CLASSIFIER_BOTTOM_N } from "./constants.js";
import { formatSessionLabel } from "./ref.js";

/**
 * Default total budget for boot: 60s. The dialog loop must reach a *stable*
 * `agent.boot.isReady` within this window or `ReplTimeout` fires.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** How long we wait between pane captures while watching for dialog advancement. */
const POLL_INTERVAL_MS = 150;

/**
 * After we respond to a dialog, the pane must show *something different*
 * within this window. If the same dialog text persists past it, we throw
 * `DialogStuck` — the response key didn't advance the pane, which means
 * either the matcher fired on stale scrollback or claude's input layer
 * isn't accepting keys (the latter is a setup error worth surfacing loudly).
 */
const DIALOG_ADVANCE_BUDGET_MS = 5_000;

/**
 * Once `isReady` first matches, the pane must hold steady for this window
 * before we declare boot complete. The empty `❯` input box can flash during
 * the welcome / MCP-init render *before input is actually interactive* — a
 * consumer that `send`s into a not-yet-interactive prompt loses the turn
 * silently (the paste lands, never submits). Requiring stability lets the
 * welcome/MCP render settle. Longer than `wait`'s idle window (250ms) because
 * boot has more going on (box draw, remote-control line, MCP connections).
 * See `engineer/wiki/wait-needs-a-transition-not-a-snapshot`.
 */
const READY_STABLE_WINDOW_MS = 1_200;

/** Boot options threaded from `create`. */
export interface BootOptions {
  /** Total boot budget (default 60s). */
  timeoutMs?: number;
  /**
   * Opt in to auto-dismissing the agent's workspace-trust dialog. Default
   * **false** — trusting a folder is an authority grant the substrate does
   * not make for the caller. Without it, an untrusted-cwd trust dialog
   * throws `WorkspaceUntrusted` before any keystroke is sent. See that
   * error's TSDoc for the persistent/global-trust caveats.
   */
  trustWorkspace?: boolean;
  /** The cwd being booted into — carried on `WorkspaceUntrusted` for the caller. */
  cwd?: string;
  /**
   * The caller-chosen `agentSessionId` for this spawn, if any. Carried onto
   * {@link AgentExitedDuringBoot} when the agent exits before ready, so the
   * (overwhelmingly likely) collision case stays actionable. Omitted for a
   * minted id — a v4 mint collides with ~zero probability, so attributing a
   * minted-id boot-death to "id in use" would mislead.
   */
  agentSessionId?: string;
}

/**
 * Boot the session: dismiss any matching dialogs in order, then wait for the
 * agent's ready predicate to hold *stably*. Throws on the documented failures.
 *
 * @throws `WorkspaceUntrusted` if the workspace-trust dialog fires and
 *   `trustWorkspace` was not set — thrown *before* any keystroke, so no
 *   persistent trust flag is written.
 * @throws `LoginRequired` if the login-method dialog fires.
 * @throws `DialogStuck` if a recognized dialog persists after its response.
 * @throws `AgentExitedDuringBoot` if the agent process exits (its session is
 *   reaped) before becoming ready — most often an `agentSessionId` collision.
 * @throws `ReplTimeout` if the total budget elapses before a stable ready.
 */
export async function bootSession(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  opts: BootOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const trustWorkspace = opts.trustWorkspace ?? false;
  const cwd = opts.cwd ?? ref.name;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new ReplTimeout(formatSessionLabel(ref), timeoutMs);
    }
    const text = await captureDuringBoot(backend, ref, opts.agentSessionId);

    // Try every dialog matcher in order — the first that fires wins.
    const matched = agent.boot.dialogs.find((d) => d.matches(text));
    if (matched) {
      await respondToDialog(backend, ref, matched, trustWorkspace, cwd);
      // Wait for the pane to advance past the matched dialog. If it stays,
      // either the response didn't land or the matcher misfired on history.
      await waitForAdvancement(backend, ref, matched);
      continue; // re-evaluate from the top
    }

    // No dialog fired. Is the REPL ready — AND stable? The empty prompt can
    // appear mid-render before input is interactive; require it to hold.
    if (agent.boot.isReady(text)) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const r = await stabilize(backend, ref, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: READY_STABLE_WINDOW_MS,
        pollMs: POLL_INTERVAL_MS,
        timeoutMs: Math.min(remaining, READY_STABLE_WINDOW_MS * 6),
      });
      // Re-confirm ready on the settled pane (the render may have moved to a
      // dialog or back to working; only a stable ready counts).
      if (r.stable && agent.boot.isReady(r.text) && !anyDialog(agent, r.text)) {
        return;
      }
      continue; // not stable yet (still rendering) — loop and re-evaluate
    }

    // Neither dialog nor ready — keep polling.
    await sleep(POLL_INTERVAL_MS);
  }
}

function anyDialog(agent: AgentDef, text: string): boolean {
  return agent.boot.dialogs.some((d) => d.matches(text));
}

/**
 * Capture the boot pane, distinguishing **the agent exiting before ready**
 * from a **backend-level fault**. The agent runs with `remain-on-exit off`, so
 * a fast exit (the dominant case: an `agentSessionId` collision — see
 * {@link AgentExitedDuringBoot}) reaps the session; the next capture then fails
 * because the session is gone, not because anything is wrong with us.
 *
 * On a capture failure we branch:
 *   - {@link BackendUnreachable} → a server-level fault (no server / wedged /
 *     spawn-failed) — surface it unchanged; it is not "the agent exited."
 *   - otherwise, probe liveness: if the session is genuinely gone, the agent
 *     exited before ready → {@link AgentExitedDuringBoot} (fast, no waiting out
 *     the 60s `ReplTimeout`). If it is still alive, the capture hiccuped for
 *     some other reason — surface the original error honestly.
 *
 * This must not mask the *alive-pane* boot failures (`LoginRequired`,
 * `WorkspaceUntrusted`, `DialogStuck`, `ReplTimeout`): those fire on captured
 * pane text or the timeout, never on a capture failure, so they are untouched.
 */
async function captureDuringBoot(
  backend: Backend,
  ref: SessionRef,
  agentSessionId: string | undefined,
): Promise<string> {
  try {
    return await backend.capture(ref, { lines: CLASSIFIER_BOTTOM_N });
  } catch (err) {
    if (err instanceof BackendUnreachable) throw err;
    const alive = await backend.exists(ref).catch(() => false);
    if (!alive) {
      throw new AgentExitedDuringBoot(formatSessionLabel(ref), agentSessionId);
    }
    throw err;
  }
}

/**
 * Respond to a matched dialog.
 *
 * - `respond.kind === "throw"` → raise the typed error.
 * - A **gated** dialog (an authority grant, e.g. workspace-trust) → throw the
 *   gate's error *before sending any key* unless the consumer opted in. The
 *   throw-before-keystroke order is load-bearing: answering the trust dialog
 *   writes a persistent trust flag, so we must not send the key on the
 *   fail-closed path.
 * - `respond.kind === "key"` → send the key; non-Enter keys get an Enter
 *   follow-up to submit (Enter is its own submit).
 */
async function respondToDialog(
  backend: Backend,
  ref: SessionRef,
  dialog: BootDialog,
  trustWorkspace: boolean,
  cwd: string,
): Promise<void> {
  if (dialog.respond.kind === "throw") {
    switch (dialog.respond.errorClass) {
      case "LoginRequired":
        throw new LoginRequired(formatSessionLabel(ref));
    }
  }

  // Authority gate: fail closed unless opted in — BEFORE any keystroke.
  if (dialog.gate) {
    const optedIn = dialog.gate.option === "trustWorkspace" && trustWorkspace;
    if (!optedIn) {
      switch (dialog.gate.errorClass) {
        case "WorkspaceUntrusted":
          throw new WorkspaceUntrusted(formatSessionLabel(ref), cwd);
      }
    }
  }

  const key = dialog.respond.key;
  await backend.send(ref, { kind: "key", key });
  // Numeric/letter dialog responses (1, 2, y, n) typically need an Enter to
  // submit; Enter is its own submit, so no follow-up needed there.
  if (key !== "Enter") {
    await backend.send(ref, { kind: "key", key: "Enter" });
  }
}

/**
 * Wait until the pane no longer matches the just-responded dialog. If the
 * matcher keeps firing past {@link DIALOG_ADVANCE_BUDGET_MS}, the response
 * didn't land — throw `DialogStuck` with the dialog's id.
 */
async function waitForAdvancement(
  backend: Backend,
  ref: SessionRef,
  matched: BootDialog,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < DIALOG_ADVANCE_BUDGET_MS) {
    await sleep(POLL_INTERVAL_MS);
    const now = await backend.capture(ref, { lines: CLASSIFIER_BOTTOM_N });
    if (!matched.matches(now)) return;
  }
  throw new DialogStuck(formatSessionLabel(ref), matched.id);
}
