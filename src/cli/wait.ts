import { type CommonOpts, type PatienceCliOpts, handleFor, patienceOpts } from "./context.js";

export interface WaitCliOpts extends CommonOpts, PatienceCliOpts {}

/**
 * `claudemux wait <name>` — block until the turn reaches a terminal
 * {@link TurnOutcome}. Prints the outcome as JSON (the `kind` plus any nested
 * `on`/`reason`) so a scripting consumer can branch on it. Exit code is 0 for
 * `completed`, non-zero otherwise, so shell callers can gate without parsing.
 * Patience is the consumer's: `--timeout-ms`/`--idle-ms`, else the CLI's own
 * wall-clock default (the library imposes none).
 */
export async function waitCli(name: string, opts: WaitCliOpts = {}): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const outcome = await handle.wait(patienceOpts(opts));
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  if (outcome.kind !== "completed") process.exitCode = 1;
}
