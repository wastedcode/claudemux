import { claude as defaultAgent } from "../agents/claude.js";
import type { AgentDef } from "../agents/types.js";
import type { Backend, SessionRef } from "../backends/types.js";
import { DEFAULT_NAMESPACE } from "./constants.js";
import { sharedDefaultBackend } from "./default-backend.js";
import { validateNamePart } from "./validate.js";

/** The options every lifecycle entry (`create`/`resume`/`adopt`) shares. */
export interface SessionContextOptions {
  /** Session name within the namespace. */
  name: string;
  /** Namespace prefix (default: `"claudemux"`). */
  namespace?: string;
  /** Agent definition (default: claude). */
  agent?: AgentDef;
  /** Backend instance (default: the process-wide shared default). */
  backend?: Backend;
}

/** The resolved front-matter every lifecycle entry derives before its own work. */
export interface SessionContext {
  readonly ref: SessionRef;
  readonly agent: AgentDef;
  readonly backend: Backend;
}

/**
 * Resolve the shared front-matter of every lifecycle entry point: default the
 * namespace, validate name + namespace, default the agent and backend, and build
 * the validated {@link SessionRef}. `create`/`resume`/`adopt` each open with THIS,
 * then own their one distinct next step — the exists-check polarity (present is a
 * collision for create/resume, absence for adopt) and spawn-vs-attach. Extracted
 * because the four-line preamble was byte-identical across all three and drifted
 * as a class (one place to fix a default or a validation rule, not three).
 */
export function resolveSessionContext(opts: SessionContextOptions): SessionContext {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  validateNamePart("namespace", namespace);
  validateNamePart("name", opts.name);
  return {
    ref: { namespace, name: opts.name },
    agent: opts.agent ?? defaultAgent,
    backend: opts.backend ?? sharedDefaultBackend(),
  };
}
