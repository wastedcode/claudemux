import { list } from "../session/registry.js";
import { type CommonOpts, backend, resolveNamespace } from "./context.js";

/**
 * `claudemux list [namespace]` — print short session names in `namespace`,
 * one per line. Default namespace is `claudemux`.
 */
export async function listCli(opts: CommonOpts = {}): Promise<void> {
  const names = await list({
    namespace: resolveNamespace(opts.namespace),
    backend: backend(opts),
  });
  for (const name of names) {
    process.stdout.write(`${name}\n`);
  }
}
