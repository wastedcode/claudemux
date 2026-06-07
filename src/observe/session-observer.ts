import type { AgentDef, HookEdge } from "../agents/types.js";
import type { Message, State } from "../types.js";
import { TailReader } from "./incremental.js";
import { type Belief, believe } from "./observer.js";

/**
 * The per-session stateful read core — the single owner of "what's true" with
 * **bounded** reads. It holds incremental {@link TailReader}s over the hook
 * rendezvous and the transcript, so each `state()`/`progress()`/`wait()` poll
 * parses only the bytes appended since the last one (O(delta), not O(file)) — the
 * fix for a long-lived session re-parsing its whole transcript every 150ms (F39).
 *
 * It accumulates the parsed edges + messages + ancestry graph across polls, and
 * resolves the transcript path from the hook's own report (free — it's already
 * in the edges) before falling back to the agent's locate. One per handle; every
 * method that reads session state defers to it. (Boot still does a one-shot full
 * read — it isn't a hot path.)
 */
export class SessionObserver {
  readonly #agent: AgentDef;
  readonly #rendezvousPath: string | undefined;
  readonly #agentSessionId: string | undefined;

  readonly #rvReader = new TailReader();
  readonly #txReader = new TailReader();
  #edges: HookEdge[] = [];
  #messages: Message[] = [];
  #parentOf = new Map<string, string | undefined>();
  #txPath: string | undefined; // memoized once resolved

  constructor(o: { agent: AgentDef; rendezvousPath?: string; agentSessionId?: string }) {
    this.#agent = o.agent;
    this.#rendezvousPath = o.rendezvousPath;
    this.#agentSessionId = o.agentSessionId;
  }

  /** Incrementally fold new rendezvous lines into the cached edges. */
  #refreshEdges(): void {
    const path = this.#rendezvousPath;
    const hooks = this.#agent.hooks;
    if (path === undefined || hooks === undefined) return;
    const { reset, lines } = this.#rvReader.poll(path);
    if (reset) this.#edges = [];
    for (const line of lines) {
      const edge = hooks.parseMarker(line);
      if (edge !== null) this.#edges.push(edge);
    }
  }

  /**
   * The transcript path: the hook-reported one (from the edges we already hold —
   * authoritative, no extra read) preferred over the agent's fragile locate.
   * Memoized once non-undefined (it is stable for a session's lifetime).
   */
  #resolveTxPath(): string | undefined {
    if (this.#txPath !== undefined) return this.#txPath;
    for (let i = this.#edges.length - 1; i >= 0; i--) {
      const p = this.#edges[i]?.transcriptPath;
      if (p !== undefined) {
        this.#txPath = p;
        return p;
      }
    }
    const transcript = this.#agent.transcript;
    if (transcript !== undefined && this.#agentSessionId !== undefined) {
      this.#txPath = transcript.locate({ agentSessionId: this.#agentSessionId }) ?? undefined;
    }
    return this.#txPath;
  }

  /** Incrementally fold new transcript lines into the cached messages + graph. */
  #refreshTranscript(): void {
    const transcript = this.#agent.transcript;
    const path = this.#resolveTxPath();
    if (path === undefined || transcript === undefined) return;
    const { reset, lines } = this.#txReader.poll(path);
    if (reset) {
      this.#messages = [];
      this.#parentOf = new Map();
    }
    for (const line of lines) {
      const m = transcript.parseLine(line);
      if (m !== null) this.#messages.push(m);
      const e = transcript.parseEdge?.(line);
      if (e !== null && e !== undefined) this.#parentOf.set(e.id, e.parentId);
    }
  }

  /**
   * The one fused {@link Belief}, given the caller's pre-classified pane and the
   * handle's authoritative interrupt flag. Refreshes both channels first.
   */
  belief(
    pane: { state: State; interrupted: boolean; nonEmpty?: boolean },
    weInterrupted: boolean,
  ): Belief {
    this.#refreshEdges();
    this.#refreshTranscript();
    const lastMessage = this.#messages[this.#messages.length - 1];
    return believe({
      edges: this.#edges,
      transcriptCount: this.#messages.length,
      ...(lastMessage === undefined ? {} : { lastMessageRole: lastMessage.role }),
      pane,
      weInterrupted,
    });
  }

  /**
   * Is the transcript **addressable** — do we hold an `agentSessionId` to locate
   * it by, or has a hook edge reported its path? This is addressability, NOT file
   * existence: a fresh session with an id (transcript not flushed yet) is
   * locatable and reads empty legitimately. `false` means we have NO handle on
   * where the transcript lives (an adopt-miss, a non-claudemux session, or a fork
   * before its first hook edge) — reads are blind, and the handle throws
   * `TranscriptUnlocatable` rather than returning a deceptive empty.
   */
  transcriptLocatable(): boolean {
    if (this.#agentSessionId !== undefined) return true;
    this.#refreshEdges();
    return this.#edges.some((e) => e.transcriptPath !== undefined);
  }

  /** The accumulated messages + ancestry graph (for `messagesSince`/`turnComplete`). */
  thread(): { messages: readonly Message[]; parentOf: Map<string, string | undefined> } {
    this.#refreshEdges(); // so the hook transcript-path is preferred on a first read
    this.#refreshTranscript();
    return { messages: this.#messages, parentOf: this.#parentOf };
  }
}
