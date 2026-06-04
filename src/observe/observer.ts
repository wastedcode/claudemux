import { readFileSync } from "node:fs";
import type { AgentDef, HookEdge } from "../agents/types.js";
import type { Message, Progress, State } from "../types.js";

/**
 * The Observer — **agent-agnostic** fusion of the reliable observe signals into
 * one belief. It knows nothing of any agent's transcript schema or hook
 * vocabulary: it reads files by path and delegates every agent-specific bit to
 * {@link AgentDef.transcript} / {@link AgentDef.hooks}, and takes the pane only
 * as a pre-classified verdict. (grep-enforced: no jsonl/claude vocabulary here.)
 *
 * **Single owner of "what's true."** `state()` and `progress()` both defer to
 * {@link believe}; `wait()` composes that belief with the patience policy. No
 * caller forms its own belief from raw signals. Fusion precedence: pane-only
 * modal states (dialog/permission) win (hooks can't see them) → else the hook
 * lifecycle (the reliable channel) → else the pane (hooks silent/off).
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

/**
 * The single fused belief about a session **right now** — the one owner of
 * "what's true." Extends {@link Progress} with the pane-only facts hooks can't
 * see (`interrupted`) and the edge timings `wait()` composes into a
 * {@link import('../types.js').TurnOutcome} (`lastStopAt` = the turn-end trigger,
 * `lastActivityAt` = a progress heartbeat). Pure: the caller supplies the
 * already-classified pane (classification is the agent's job, fusion is ours).
 */
export interface Belief extends Progress {
  /** The pane shows an interrupted (ESC'd) turn — `wait()` maps this to `aborted`. */
  readonly interrupted: boolean;
  /** ms of the most recent turn-end (`stop`) edge, if any. */
  readonly lastStopAt?: number;
  /** ms of the most recent lifecycle edge of any kind — a liveness heartbeat. */
  readonly lastActivityAt?: number;
}

/**
 * Edges from the **current** session lifecycle only: everything from the latest
 * `session-start` onward. The rendezvous is keyed by conversation id and *reused
 * across resume*, so a crashed prior life leaves an unclosed `prompt-submit` (and
 * a stale `session-start`) in the same file. Computing the belief over those
 * poisons it (the false-`working`-after-resume bug). Resetting at the last
 * `session-start` boundary is the one fix for that whole family. Edges are sorted
 * by time, so the last `session-start` in the array is the most recent; with no
 * `session-start` at all (a bare progress sequence) everything is kept.
 */
export function currentLifeEdges(edges: readonly HookEdge[]): readonly HookEdge[] {
  let lastStart = -1;
  for (let i = 0; i < edges.length; i++) {
    if (edges[i]?.event === "session-start") lastStart = i;
  }
  return lastStart < 0 ? edges : edges.slice(lastStart);
}

/**
 * Fuse the reliable signals + the pre-classified pane into one {@link Belief}.
 * `state` precedence: pane-only modals (dialog/permission) → hook lifecycle
 * (when the channel is live and a turn has happened) → pane (hooks silent/off).
 * Only {@link currentLifeEdges} feed the belief, so a resumed session is never
 * judged by its prior life's edges.
 */
export function believe(o: {
  edges: readonly HookEdge[];
  transcriptCount: number;
  pane: { state: State; interrupted: boolean };
  /**
   * Authoritative "this handle issued an interrupt not yet superseded by a send."
   * An interrupt fires NO `stop` edge AND leaves the spinner's `esc to interrupt`
   * frozen in scrollback (so the pane mis-classifies as `working`) — neither
   * channel can tell a frozen spinner from a live one. The handle KNOWS, so this
   * flag overrides both. The pane's "Interrupted" text is only a best-effort
   * fallback for a *human* interrupt we didn't issue.
   */
  weInterrupted?: boolean;
}): Belief {
  const edges = currentLifeEdges(o.edges);
  const prog = deriveProgress({ edges, transcriptCount: o.transcriptCount });
  // `weInterrupted` is authoritative; else the human-interrupt heuristic: the
  // pane shows "Interrupted" AND is the post-interrupt draft (`unknown`), not a
  // working/idle box (a new turn, or a resume replaying old "Interrupted" text).
  const interrupted =
    o.weInterrupted === true || (o.pane.interrupted && o.pane.state === "unknown");
  let state: State;
  if (o.pane.state === "dialog" || o.pane.state === "permission-prompt") {
    state = o.pane.state; // only the pane sees modals — they win
  } else if (interrupted) {
    state = "unknown"; // aborted: hook phase is stale, pane is a draft (not idle)
  } else if (prog.hookChannelHealthy && prog.phase !== "unknown") {
    state = prog.state; // the reliable hook lifecycle (working / idle)
  } else {
    state = o.pane.state; // hooks silent (off, or no turn yet) → trust the pane
  }
  const lastStop = [...edges].reverse().find((e) => e.event === "stop");
  const lastEdge = edges[edges.length - 1];
  return {
    ...prog,
    state,
    interrupted,
    ...(lastStop === undefined ? {} : { lastStopAt: lastStop.at }),
    ...(lastEdge === undefined ? {} : { lastActivityAt: lastEdge.at }),
  };
}

/**
 * Assemble the {@link Belief} from the on-disk signals (hook rendezvous +
 * transcript) and a **pre-classified** pane. The caller — which holds the
 * backend — captures the pane and classifies it with the agent's rules (state +
 * interrupted); this wires the file reads and fuses via {@link believe}. Keeps
 * the Observer agent-agnostic (no classification here) while remaining the one
 * place the belief is formed.
 */
export function assembleBelief(o: {
  agent: AgentDef;
  rendezvousPath?: string;
  transcriptPath?: string;
  pane: { state: State; interrupted: boolean };
  weInterrupted?: boolean;
}): Belief {
  const edges =
    o.rendezvousPath === undefined
      ? []
      : readHookEdges({ agent: o.agent, rendezvousPath: o.rendezvousPath });
  let transcriptCount = 0;
  const transcript = o.agent.transcript;
  if (o.transcriptPath !== undefined && transcript !== undefined) {
    for (const line of readLines(o.transcriptPath)) {
      if (transcript.parseLine(line) !== null) transcriptCount += 1;
    }
  }
  return believe({
    edges,
    transcriptCount,
    pane: o.pane,
    ...(o.weInterrupted === undefined ? {} : { weInterrupted: o.weInterrupted }),
  });
}

/**
 * Read the hook rendezvous into ordered {@link HookEdge}s (chronological).
 * Empty when hooks are off, the agent has no hook spec, or the file is absent
 * — degrades, never throws. The agent owns the marker grammar
 * ({@link AgentDef.hooks.parseMarker}); this stays agent-agnostic.
 */
export function readHookEdges(o: { agent: AgentDef; rendezvousPath: string }): HookEdge[] {
  const hooks = o.agent.hooks;
  if (hooks === undefined) return [];
  const edges: HookEdge[] = [];
  for (const line of readLines(o.rendezvousPath)) {
    const edge = hooks.parseMarker(line);
    if (edge !== null) edges.push(edge);
  }
  edges.sort((a, b) => a.at - b.at);
  return edges;
}

/**
 * Resolve the session's transcript path, preferring the **authoritative**
 * locator the hook reported (`transcriptPath` on the latest edge that carries
 * one) over the agent's fragile on-disk recompute/glob. Falls back to the
 * agent's `locate()` when hooks are off/absent, then to `null`. This is the
 * fusion that lets us stop globbing whenever the hook channel is live.
 */
export function resolveTranscriptPath(o: {
  agent: AgentDef;
  rendezvousPath?: string;
  agentSessionId?: string;
}): string | null {
  if (o.rendezvousPath !== undefined) {
    const edges = readHookEdges({ agent: o.agent, rendezvousPath: o.rendezvousPath });
    for (let i = edges.length - 1; i >= 0; i--) {
      const p = edges[i]?.transcriptPath;
      if (p !== undefined) return p;
    }
  }
  const transcript = o.agent.transcript;
  if (transcript !== undefined && o.agentSessionId !== undefined) {
    return transcript.locate({ agentSessionId: o.agentSessionId });
  }
  return null;
}

/** Read the hook rendezvous + transcript and produce a fused {@link Progress}. */
export function observeProgress(o: {
  agent: AgentDef;
  rendezvousPath?: string;
  transcriptPath?: string;
}): Progress {
  const edges =
    o.rendezvousPath === undefined
      ? []
      : readHookEdges({ agent: o.agent, rendezvousPath: o.rendezvousPath });

  let transcriptCount = 0;
  const transcript = o.agent.transcript;
  if (o.transcriptPath !== undefined && transcript !== undefined) {
    for (const line of readLines(o.transcriptPath)) {
      if (transcript.parseLine(line) !== null) transcriptCount += 1;
    }
  }

  return deriveProgress({ edges: currentLifeEdges(edges), transcriptCount });
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

/**
 * Read the transcript once into both the surfaced {@link Message}s and the
 * **full** ancestry graph (`id → parentId` over *every* linkable record, not
 * just messages). The graph lets a consumer detect message descendants even
 * when the causal chain passes through records {@link readMessages} drops (e.g.
 * the `attachment` records claude threads between a prompt and its reply). When
 * the agent exposes no `parseEdge`, `parentOf` is empty and callers fall back
 * to message-only links.
 */
export function readThread(o: { agent: AgentDef; transcriptPath: string }): {
  messages: Message[];
  parentOf: Map<string, string | undefined>;
} {
  const transcript = o.agent.transcript;
  const messages: Message[] = [];
  const parentOf = new Map<string, string | undefined>();
  if (transcript === undefined) return { messages, parentOf };
  for (const line of readLines(o.transcriptPath)) {
    const m = transcript.parseLine(line);
    if (m !== null) messages.push(m);
    if (transcript.parseEdge !== undefined) {
      const e = transcript.parseEdge(line);
      if (e !== null) parentOf.set(e.id, e.parentId);
    }
  }
  return { messages, parentOf };
}
