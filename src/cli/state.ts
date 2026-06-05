import { type CommonOpts, handleFor } from "./context.js";

/**
 * `claudemux state <name>` — print the current pane state
 * (`working` / `idle` / `permission-prompt` / `dialog` / `unknown`).
 */
export async function stateCli(name: string, opts: CommonOpts = {}): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const state = await handle.state();
  process.stdout.write(`${state}\n`);
}
