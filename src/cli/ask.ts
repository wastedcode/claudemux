import { ask } from "../compose.js";
import { type CommonOpts, handleFor, readStdin } from "./context.js";

export interface AskCliOpts extends CommonOpts {
  timeoutMs?: number;
}

/**
 * `claudemux ask <name> <text>` — the Q&A round-trip face: send → wait → read.
 * Prints the {@link AskResult} as JSON (`outcome`, `messages`, `cursor`). Exit
 * code is 0 on `completed`, non-zero otherwise, so a shell caller can gate
 * without parsing. `text` = `"-"` reads the prompt from stdin.
 */
export async function askCli(name: string, text: string, opts: AskCliOpts = {}): Promise<void> {
  const body = text === "-" ? await readStdin() : text;
  const handle = await handleFor({ ...opts, name });
  const result = await ask(
    handle,
    body,
    opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome.kind !== "completed") process.exitCode = 1;
}
