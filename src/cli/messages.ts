import { type CommonOpts, handleFor } from "./context.js";

/**
 * `claudemux messages <name> <cursor>` — read the messages produced since the
 * given cursor (the one `send`/`ask` emitted). Prints them as a JSON array.
 * The CLI read face for the library's `messagesSince(cursor)` — without it,
 * `send` would emit a cursor the CLI could never consume.
 */
export async function messagesCli(
  name: string,
  cursor: string,
  opts: CommonOpts = {},
): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const messages = await handle.messagesSince(cursor);
  process.stdout.write(`${JSON.stringify(messages)}\n`);
}
