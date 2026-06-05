import { type CommonOpts, handleFor } from "./context.js";

export interface CaptureCliOpts extends CommonOpts {
  ansi?: boolean;
  lines?: number;
}

/** `claudemux capture <name>` — print the pane text (optionally with ANSI). */
export async function captureCli(name: string, opts: CaptureCliOpts = {}): Promise<void> {
  const handle = await handleFor({ ...opts, name });
  const captureOpts: { ansi?: boolean; lines?: number } = {};
  if (opts.ansi === true) captureOpts.ansi = true;
  if (opts.lines !== undefined) captureOpts.lines = opts.lines;
  const text = await handle.capture(captureOpts);
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}
