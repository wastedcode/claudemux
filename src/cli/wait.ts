import { type CommonOpts, handleFor } from "./context.js";

export interface WaitCliOpts extends CommonOpts {
  timeoutMs?: number;
}

/**
 * `claudemux wait <name>` — block until the turn reaches a terminal
 * {@link TurnOutcome}. Prints the outcome as JSON (the `kind` plus any nested
 * `on`/`reason`) so a scripting consumer can branch on it. Exit code is 0 for
 * `completed`, non-zero otherwise, so shell callers can gate without parsing.
 */
export async function waitCli(name: string, opts: WaitCliOpts = {}): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const outcome = await handle.wait(
    opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
  );
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (outcome.kind !== "completed") process.exitCode = 1;
}
