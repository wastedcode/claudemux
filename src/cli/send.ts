import { type CommonOpts, handleFor, readStdin } from "./context.js";

/**
 * `claudemux send <name> <text>` — deliver text as one logical user turn.
 *
 * If `text` is `"-"`, the body is read from stdin (useful for piping in
 * larger payloads or templated content).
 */
export async function sendCli(name: string, text: string, opts: CommonOpts = {}): Promise<void> {
  const body = text === "-" ? await readStdin() : text;
  const handle = await handleFor({ ...opts, name });
  const cursor = await handle.send(body);
  // Emit the cursor so `claudemux messages <name> <cursor>` can read this turn's
  // output (CLI mirrors the library's send → cursor contract).
  process.stdout.write(`${JSON.stringify({ cursor })}\n`);
}
