import { list } from "../session/registry.js";
import { backend, resolveNamespace } from "./context.js";

/**
 * `claudemux list [namespace]` — print short session names in `namespace`,
 * one per line. Default namespace is `claudemux`.
 */
export async function listCli(opts: { namespace?: string } = {}): Promise<void> {
  const names = await list({
    namespace: resolveNamespace(opts.namespace),
    backend: backend(),
  });
  for (const name of names) {
    process.stdout.write(`${name}\n`);
  }
}
