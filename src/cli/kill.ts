import { kill } from "../session/registry.js";
import { type CommonOpts, backend, resolveNamespace } from "./context.js";

/**
 * `claudemux kill <name>` — kill exactly the named session. Idempotent:
 * killing a session that's already gone exits 0.
 */
export async function killCli(name: string, opts: CommonOpts = {}): Promise<void> {
  await kill({
    name,
    namespace: resolveNamespace(opts.namespace),
    backend: backend(opts),
  });
}
