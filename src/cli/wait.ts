import { type CommonOpts, handleFor } from "./context.js";

export interface WaitCliOpts extends CommonOpts {
  timeoutMs?: number;
}

/**
 * `claudemux wait <name>` — block until the session reaches an idle state,
 * a permission prompt, or a dialog. Prints the resulting state to stdout.
 */
export async function waitCli(name: string, opts: WaitCliOpts = {}): Promise<void> {
  const handle = handleFor({ ...opts, name });
  const state = await handle.wait(
    opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
  );
  process.stdout.write(`${state}\n`);
}
