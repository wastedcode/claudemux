import type { PromptChoice } from "../types.js";
import { type CommonOpts, handleFor } from "./context.js";

/** The CLI choice tokens, mapped 1:1 to the neutral {@link PromptChoice}. */
const CHOICES: Record<string, PromptChoice> = {
  approve: "approve",
  "approve-for-session": "approve-for-session",
  deny: "deny",
};

/**
 * `claudemux respond <name> <choice>` — answer the permission prompt the
 * session is awaiting. Mirrors the `respond()` library verb 1:1. `<choice>` is
 * one of `approve` / `approve-for-session` / `deny` (NOT a digit — the menu
 * order is the agent's, not the caller's). Gate on `state <name>` reading
 * `permission-prompt` first, in the same quick sequence.
 */
export async function respondCli(
  name: string,
  choice: string,
  opts: CommonOpts = {},
): Promise<void> {
  const parsed = CHOICES[choice];
  if (parsed === undefined) {
    throw new Error(
      `unknown choice ${JSON.stringify(choice)}; expected one of: ${Object.keys(CHOICES).join(", ")}`,
    );
  }
  const handle = await handleFor({ ...opts, name });
  await handle.respond(parsed);
}
