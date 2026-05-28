import { exists } from "../session/registry.js";
import { type CommonOpts, backend, resolveNamespace } from "./context.js";

/**
 * `claudemux exists <name>` — print `true` / `false` and exit 0 / 1
 * (matches POSIX shell convention: existence as success).
 */
export async function existsCli(name: string, opts: CommonOpts = {}): Promise<void> {
  const ok = await exists({
    name,
    namespace: resolveNamespace(opts.namespace),
    backend: backend(),
  });
  process.stdout.write(`${ok}\n`);
  process.exit(ok ? 0 : 1);
}
