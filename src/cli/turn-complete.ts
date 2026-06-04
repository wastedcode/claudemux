import { type CommonOpts, handleFor } from "./context.js";

/**
 * `claudemux turn-complete <name> <cursor>` — print `true`/`false` and exit 0/1
 * for "did the turn at <cursor> produce a reply?". The crash-recovery face: after
 * a `resume`, exit 1 (false) on your last-sent cursor means re-send that prompt.
 */
export async function turnCompleteCli(
  name: string,
  cursor: string,
  opts: CommonOpts = {},
): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const done = await handle.turnComplete(cursor);
  process.stdout.write(`${done}\n`);
  if (!done) process.exitCode = 1;
}
