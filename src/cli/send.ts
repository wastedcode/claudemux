import { type CommonOpts, handleFor } from "./context.js";

/**
 * `claudemux send <name> <text>` — deliver text as one logical user turn.
 *
 * If `text` is `"-"`, the body is read from stdin (useful for piping in
 * larger payloads or templated content).
 */
export async function sendCli(name: string, text: string, opts: CommonOpts = {}): Promise<void> {
  const body = text === "-" ? await readStdin() : text;
  const handle = handleFor({ ...opts, name });
  const cursor = await handle.send(body);
  // Emit the cursor so `claudemux messages <name> --since <cursor>` can read
  // this turn's output (CLI mirrors the library's send → cursor contract).
  process.stdout.write(`${JSON.stringify({ cursor })}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
