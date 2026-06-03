import { readFileSync } from "node:fs";
import type { AgentDef, HookEdge } from "../agents/types.js";
import type { Message, Progress } from "../types.js";

/**
 * The Observer — **agent-agnostic** fusion of the reliable observe signals into
 * a {@link Progress} snapshot and neutral {@link Message}s. It knows nothing of
 * any agent's transcript schema or hook vocabulary: it reads files by path and
 * delegates every agent-specific bit to {@link AgentDef.transcript} /
 * {@link AgentDef.hooks}. (grep-enforced: no jsonl/claude vocabulary here.)
 *
 * Reliability ordering: hooks + transcript are primary; the pane is a separate,
 * marked-unreliable fallback wired in by the state/wait consolidation, not here.
 */

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return []; // absent/unreadable file → no signal (degrades, never throws)
  }
}

/**
 * Derive a {@link Progress} from the ordered hook edges + a transcript count.
 * Pure — the testable heart of the Observer.
 *
 * `phase`: `stop` ⇒ `done`; else a tool in flight ⇒ `tool`; else the last edge
 * being `tool-end` ⇒ `composing`; else ⇒ `prompt`; no edges ⇒ `unknown`.
 * `toolInFlight`: net-open tools (`tool-start` count minus `tool-end` count).
 */
export function deriveProgress(o: {
  edges: readonly HookEdge[];
  transcriptCount: number;
}): Progress {
  let open = 0;
  for (const e of o.edges) {
    if (e.event === "tool-start") open += 1;
    else if (e.event === "tool-end") open = Math.max(0, open - 1);
  }
  const toolInFlight = open > 0;

  const lifecycle = o.edges.filter(
    (e) =>
      e.event === "prompt-submit" ||
      e.event === "tool-start" ||
      e.event === "tool-end" ||
      e.event === "stop",
  );
  const last = lifecycle[lifecycle.length - 1];
  let phase: Progress["phase"];
  if (last === undefined) phase = "unknown";
  else if (last.event === "stop") phase = "done";
  else if (toolInFlight) phase = "tool";
  else if (last.event === "tool-end") phase = "composing";
  else phase = "prompt";

  const hookChannelHealthy = o.edges.length > 0;
  // Hook-derived state. The pane fallback (dialog / permission-prompt) is fused
  // in by the state/wait consolidation; here state reflects only the reliable
  // hook signal: working unless the turn has ended (or no signal at all).
  const state: Progress["state"] =
    phase === "done" ? "idle" : phase === "unknown" ? "unknown" : "working";

  return { phase, toolInFlight, transcriptCount: o.transcriptCount, hookChannelHealthy, state };
}

/** Read the hook rendezvous + transcript and produce a fused {@link Progress}. */
export function observeProgress(o: {
  agent: AgentDef;
  rendezvousPath?: string;
  transcriptPath?: string;
}): Progress {
  const edges: HookEdge[] = [];
  const hooks = o.agent.hooks;
  if (o.rendezvousPath !== undefined && hooks !== undefined) {
    for (const line of readLines(o.rendezvousPath)) {
      const edge = hooks.parseMarker(line);
      if (edge !== null) edges.push(edge);
    }
    edges.sort((a, b) => a.at - b.at);
  }

  let transcriptCount = 0;
  const transcript = o.agent.transcript;
  if (o.transcriptPath !== undefined && transcript !== undefined) {
    for (const line of readLines(o.transcriptPath)) {
      if (transcript.parseLine(line) !== null) transcriptCount += 1;
    }
  }

  return deriveProgress({ edges, transcriptCount });
}

/** Read the transcript into neutral {@link Message}s (skips metadata/partial lines). */
export function readMessages(o: { agent: AgentDef; transcriptPath: string }): Message[] {
  const transcript = o.agent.transcript;
  if (transcript === undefined) return [];
  const out: Message[] = [];
  for (const line of readLines(o.transcriptPath)) {
    const m = transcript.parseLine(line);
    if (m !== null) out.push(m);
  }
  return out;
}
