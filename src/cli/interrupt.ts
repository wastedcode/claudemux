import { type CommonOpts, handleFor } from "./context.js";

/**
 * `claudemux interrupt <name>` — fire ESC at the session to stop a working
 * agent. Mirrors the `interrupt()` library verb 1:1 (no body, unlike `send`).
 *
 * ESC is sent regardless of state; it is meaningful only when the agent is
 * `working`. ESC on an idle claude is harmless (it clears the input box).
 */
export async function interruptCli(name: string, opts: CommonOpts = {}): Promise<void> {
  const handle = handleFor({ ...opts, name });
  await handle.interrupt();
}
