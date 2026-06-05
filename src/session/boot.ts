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
import { readHookEdges } from "../observe/observer.js";
import { sleep } from "../util/sleep.js";
import { CLASSIFIER_BOTTOM_N, CLASSIFIER_CAPTURE } from "./constants.js";
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
  /**
   * Path to the session's hook rendezvous file, when hooks were injected
   * (default-on). When set, boot **gates** readiness on the agent's
   * `SessionStart` hook edge appearing here: a ready-looking pane alone never
   * declares ready until the edge fires. Verified against claude 2.1.162:
   * `SessionStart` fires only *after* any boot dialog is dismissed, once input
   * is interactive — so an edge can never signal ready while a dialog is up.
   * After the edge, boot still waits for a *stable* `isReady` pane (the first
   * send otherwise races the welcome/MCP render storm and is lost). Omitted
   * under `create({ hooks: false })`, where the pane is the only ready signal.
   */
  rendezvousPath?: string;
}

/**
 * Boot the session: dismiss any matching dialogs in order, then wait for ready.
 *
 * **Ready signal:** a hook *gate* plus a pane *settle*.
 *   1. **`session-start` hook edge — the authoritative "started" gate.** With
 *      hooks on (the default, `opts.rendezvousPath` set), boot will not declare
 *      ready until this edge fires — a ready-*looking* pane is NOT trusted on
 *      its own (the founder's "hooks, not screen-scraping" north star). The edge
 *      lands only once input is interactive and post-dialog. With hooks off
 *      there is no edge, so the pane is the only signal.
 *   2. **Stable ready box — the delivery-safety settle.** Even after "started,"
 *      a fresh REPL is still painting its welcome/MCP render, and the *first*
 *      send pasted into that render storm is silently lost (verified). So boot
 *      returns only once the ready box has held *stable*, guaranteeing the input
 *      is paintable. Dialogs are handled before either check each iteration.
 *
 * Throws on the documented failures.
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

  // The rendezvous is reused across resume, so it may ALREADY hold the prior
  // life's `session-start`. Baseline the count now and wait for a NEW one — else
  // a resume boots "ready" on a stale edge (clock-independent: count, not time).
  const priorStarts = countSessionStarts(agent, opts.rendezvousPath);

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new ReplTimeout(formatSessionLabel(ref), timeoutMs);
    }
    const text = await captureDuringBoot(backend, ref, opts.agentSessionId);

    // Try every dialog matcher in order — the first that fires wins. Dialogs
    // are always handled before any ready check (hook or pane), so neither can
    // declare ready while a dialog is still on screen.
    const matched = agent.boot.dialogs.find((d) => d.matches(text));
    if (matched) {
      await respondToDialog(backend, ref, matched, trustWorkspace, cwd);
      // Wait for the pane to advance past the matched dialog. If it stays,
      // either the response didn't land or the matcher misfired on history.
      await waitForAdvancement(backend, ref, matched);
      continue; // re-evaluate from the top
    }

    // Authoritative "session has started" gate: the agent's SessionStart hook
    // edge (when hooks are on). The edge only lands once input is interactive
    // and post-dialog, so we DON'T trust a ready-looking pane until it fires —
    // that is the founder's "hooks, not screen-scraping" north star. With hooks
    // off, there is no edge, so the pane is the only signal.
    const hooksOn = opts.rendezvousPath !== undefined;
    const started = !hooksOn || countSessionStarts(agent, opts.rendezvousPath) > priorStarts;
    if (!started) {
      await sleep(POLL_INTERVAL_MS); // session not started yet — wait for the edge
      continue;
    }

    // Started — but a fresh REPL is still painting its welcome/MCP render, and a
    // paste into that render storm is silently lost (verified: the first send
    // races a repaint). So gate the RETURN on a *stable* ready box: the hook
    // says "started", the pane settle says "the input is paintable now." The
    // empty box can also flash mid-render, so requiring it to hold is necessary
    // regardless of the hook.
    if (agent.boot.isReady(text)) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - start));
      const r = await stabilize(backend, ref, {
        lines: CLASSIFIER_BOTTOM_N,
        windowMs: READY_STABLE_WINDOW_MS,
        pollMs: POLL_INTERVAL_MS,
        timeoutMs: Math.min(remaining, READY_STABLE_WINDOW_MS * 6),
        ansi: true,
      });
      // Re-confirm ready on the settled pane (the render may have moved to a
      // dialog or back to working; only a stable ready counts).
      if (r.stable && agent.boot.isReady(r.text) && !anyDialog(agent, r.text)) {
        return;
      }
      continue; // not stable yet (still rendering) — loop and re-evaluate
    }

    // Started but the box isn't ready yet (still rendering) — keep polling.
    await sleep(POLL_INTERVAL_MS);
  }
}

function anyDialog(agent: AgentDef, text: string): boolean {
  return agent.boot.dialogs.some((d) => d.matches(text));
}

/** How many `session-start` edges the rendezvous holds (0 when hooks off/absent). */
function countSessionStarts(agent: AgentDef, rendezvousPath: string | undefined): number {
  if (rendezvousPath === undefined) return 0;
  return readHookEdges({ agent, rendezvousPath }).filter((e) => e.event === "session-start").length;
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
    return await backend.capture(ref, CLASSIFIER_CAPTURE);
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
    const now = await backend.capture(ref, CLASSIFIER_CAPTURE);
    if (!matched.matches(now)) return;
  }
  throw new DialogStuck(formatSessionLabel(ref), matched.id);
}
