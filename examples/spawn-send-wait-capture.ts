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

    const cursor = await session.send("Print 'hello from claudemux' and stop.");
    // wait() blocks until a terminal outcome; the library imposes no deadline.
    // Supply your own patience to cap it — wait({ maxMs }) and/or wait({ idleMs }).
    const outcome = await session.wait(); // → a TurnOutcome you branch on
    process.stdout.write(`outcome: ${outcome.kind}\n`); // "completed"

    if (outcome.kind === "completed") {
      const msgs = await session.messagesSince(cursor); // reply is readable on completed
      const reply = msgs.flatMap((m) => m.parts.map((p) => ("text" in p ? p.text : ""))).join(" ");
      process.stdout.write(`--- reply ---\n${reply}\n--- end ---\n`);
    }

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
