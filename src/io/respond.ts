import type { Backend, SendPayload } from "../backends/types.js";
import { sleep } from "../util/sleep.js";

/** The keystroke a `key` payload can carry (the agent picks which one). */
type KeyName = Extract<SendPayload, { kind: "key" }>["key"];

/** Confirm-window: poll up to ~5s for the answered prompt to clear. */
const CONFIRM_POLLS = 20;
const CONFIRM_POLL_MS = 250;

/**
 * Answer an agent prompt: fire the single keystroke that selects the choice,
 * then **self-confirm** the prompt cleared before returning — the analog of
 * {@link import('./send.js').sendOnce} anchoring its own user record.
 *
 * Without the confirm, the call returns while the menu is still painted (the
 * agent repaints prompt→working only after processing the key), so a following
 * `wait()` latches the STALE prompt and reports `awaiting` again. The reliable
 * signal is SEMANTIC — `stillPrompted()` (the caller's belief check) returning
 * false — NOT a raw pane diff: a cursor blink between two captures fires a
 * spurious change before the key takes effect (the race this exists to close).
 *
 * The mechanism owns *delivery + settle*; it stays agnostic of (a) which key
 * means what — the agent maps choice→key and hands `key` in — and (b) how
 * "still prompted" is decided — the caller injects `stillPrompted` (the
 * Observer's belief). Bounded + best-effort: if the prompt never clears (a
 * second prompt stacked, or the key was dropped) it returns anyway and the
 * caller's next `wait()` re-reads. It does exactly the one keystroke it names
 * (`brain/decisions/0013` — a primitive does exactly the keystroke it names).
 */
export async function respondOnce(
  backend: Backend,
  ref: Parameters<Backend["send"]>[0],
  key: KeyName,
  stillPrompted: () => Promise<boolean>,
): Promise<void> {
  await backend.send(ref, { kind: "key", key });
  for (let i = 0; i < CONFIRM_POLLS; i++) {
    if (!(await stillPrompted())) return;
    await sleep(CONFIRM_POLL_MS);
  }
}
