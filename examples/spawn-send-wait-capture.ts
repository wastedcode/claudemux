/**
 * The canonical 30-second example: spawn → send → wait → capture → kill.
 *
 * This file imports from the published package name (`claudemux`), not
 * `../src/index.js` — so it runs the same way a consumer would after
 * `npm install claudemux`.
 *
 * **Expected behavior in a fresh `~/.claude/`:** `create()` will throw
 * `LoginRequired` because claude isn't authenticated. That's the design
 * — run `claude` interactively once to sign in, then re-run this script.
 */

import { LoginRequired, create } from "claudemux";

async function main(): Promise<void> {
  try {
    const session = await create({
      name: "example-job",
      cwd: process.cwd(),
      bootTimeoutMs: 60_000,
    });

    await session.send("Print 'hello from claudemux' and stop.");
    const finalState = await session.wait();
    process.stdout.write(`final state: ${finalState}\n`);

    const text = await session.capture({ lines: 20 });
    process.stdout.write("--- pane tail ---\n");
    process.stdout.write(text);
    process.stdout.write("--- end ---\n");

    await session.kill();
  } catch (err) {
    if (err instanceof LoginRequired) {
      process.stderr.write(
        "claudemux: claude is not authenticated. Run `claude` interactively once to sign in, then re-run this script.\n",
      );
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
