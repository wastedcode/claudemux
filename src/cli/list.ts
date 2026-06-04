import { list } from "../session/registry.js";
import { type RefOpts, backend, resolveNamespace } from "./context.js";

/**
 * `claudemux list [namespace]` — print short session names in `namespace`, one
 * per line. The namespace may come from the positional OR `--namespace`; the
 * flag wins when both are given (the CLI's cross-verb vocabulary uses the flag).
 * That reconciliation is owned HERE, not in the command wiring — every other
 * verb passes opts straight through, so this verb shouldn't be the exception.
 */
export async function listCli(
  positionalNamespace: string | undefined,
  opts: RefOpts = {},
): Promise<void> {
  const names = await list({
    namespace: resolveNamespace(opts.namespace ?? positionalNamespace),
    backend: backend(opts),
  });
  for (const name of names) {
    process.stdout.write(`${name}\n`);
  }
}
