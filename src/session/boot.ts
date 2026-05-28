import type { AgentDef, BootDialog } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { DialogStuck, LoginRequired, ReplTimeout } from "../errors.js";

/**
 * Default total budget for boot: 60s. The dialog loop must reach
 * `agent.boot.isReady === true` within this window or `ReplTimeout` fires.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** How long we wait between pane captures while watching for dialog advancement. */
const POLL_INTERVAL_MS = 150;

/**
 * How many lines from the bottom of the pane to scan for dialog/ready
 * patterns. 50 covers claude's tallest dialog (theme picker, ~10 lines)
 * with comfortable headroom; prevents scrollback false-positives.
 */
const BOTTOM_N_LINES = 50;

/**
 * After we respond to a dialog, the pane must show *something different*
 * within this window. If the same dialog text persists past it, we throw
 * `DialogStuck` — the response key didn't advance the pane, which means
 * either the matcher fired on stale scrollback or claude's input layer
 * isn't accepting keys (the latter is a setup error worth surfacing loudly).
 */
const DIALOG_ADVANCE_BUDGET_MS = 5_000;

/** Render a SessionRef into the typed-error session-name slot. */
function refLabel(ref: SessionRef): string {
  return `${ref.namespace}--${ref.name}`;
}

/**
 * Boot the session: dismiss any matching dialogs in order, then wait for
 * the agent's ready predicate. Throws on the three documented failures.
 *
 * @throws `DialogStuck` if a recognized dialog persists after its response.
 * @throws `ReplTimeout` if the total budget elapses before ready.
 * @throws `LoginRequired` if the login-method dialog fires (claudemux
 *   assumes the user is already authenticated; firing this dialog is a
 *   setup error, not an auto-answerable prompt).
 */
export async function bootSession(
  backend: Backend,
  agent: AgentDef,
  ref: SessionRef,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new ReplTimeout(refLabel(ref), timeoutMs);
    }
    const text = await backend.capture(ref, { lines: BOTTOM_N_LINES });

    // Try every dialog matcher in order — the first that fires wins.
    const matched = agent.boot.dialogs.find((d) => d.matches(text));
    if (matched) {
      await respondToDialog(backend, ref, matched);
      // Wait for the pane to advance past the matched dialog. If it stays,
      // either the response didn't land or the matcher misfired on history.
      await waitForAdvancement(backend, ref, matched);
      continue; // re-evaluate from the top
    }

    // No dialog fired. Is the REPL ready?
    if (agent.boot.isReady(text)) return;

    // Neither dialog nor ready — keep polling.
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

/**
 * Send the dialog's response. For the `throw` variant, raises the typed
 * error directly. For the `key` variant: sends the key, plus an `Enter`
 * follow-up if the response is a non-submit digit/letter — the only
 * submit-on-press key in the substrate's key set is `Enter`.
 */
async function respondToDialog(
  backend: Backend,
  ref: SessionRef,
  dialog: BootDialog,
): Promise<void> {
  if (dialog.respond.kind === "throw") {
    if (dialog.respond.errorClass === "LoginRequired") {
      throw new LoginRequired(refLabel(ref));
    }
    // Future error classes go here; v0.0.1 has only LoginRequired.
    throw new LoginRequired(refLabel(ref));
  }
  const key = dialog.respond.key;
  await backend.send(ref, { kind: "key", key });
  // Numeric/letter dialog responses (1, 2, y, n) typically need an Enter
  // to submit; Enter is its own submit, so no follow-up needed there.
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
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    const now = await backend.capture(ref, { lines: BOTTOM_N_LINES });
    if (!matched.matches(now)) return;
  }
  throw new DialogStuck(refLabel(ref), matched.id);
}
