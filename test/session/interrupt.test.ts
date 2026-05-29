import { describe, expect, it } from "vitest";
import { claude } from "../../src/agents/claude.js";
import type { Backend, SendPayload, SessionRef } from "../../src/backends/types.js";
import { makeHandle } from "../../src/session/handle.js";

/**
 * Offline `interrupt()` invariants — the parts provable without a live claude.
 * The behavioral cases that need a genuinely-working agent (interrupt() while
 * working leaves the `"esc to interrupt"` affordance; idle is harmless; the
 * composed interrupt→wait→send) live in the auth-gated `interrupt.live.test.ts`.
 *
 * These two layers mirror how `send`/`wait` are split: the mutex/ordering
 * contract is checked against a fake backend here; the real pane behavior is
 * proven live.
 */

/**
 * Records every `send` payload in call order and yields control mid-call, so
 * that — absent the per-handle mutex — a concurrent `interrupt` could interleave
 * its `Escape` between `send`'s `paste` and `Enter`. `capture` returns a working
 * frame distinct from the pre-send frame so `send`'s post-submit baseline loop
 * settles immediately instead of polling to its budget.
 */
function recordingBackend(): { backend: Backend; sends: SendPayload[] } {
  const sends: SendPayload[] = [];
  const state = { captures: 0 };
  const backend: Backend = {
    id: "fake",
    spawn: async () => {},
    kill: async () => {},
    exists: async () => true,
    list: async () => [],
    send: async (_ref: SessionRef, payload: SendPayload) => {
      sends.push(payload);
      // Force a scheduling boundary mid-call: without the mutex this is exactly
      // where another handle method could slip a write in.
      await new Promise((r) => setTimeout(r, 1));
    },
    capture: async () => {
      state.captures++;
      // First capture is `send`'s pre-send frame; later ones are the post-submit
      // working frame (different text + `working()` true ⇒ baseline settles).
      return state.captures === 1 ? "idle prompt box" : "· esc to interrupt";
    },
    setSessionMeta: async () => {},
    getSessionMeta: async () => undefined,
    onCommand: () => () => {},
  };
  return { backend, sends };
}

const DEPS = (backend: Backend) => ({
  backend,
  agent: claude,
  namespace: "claudemux",
  name: "t",
});

describe("interrupt() — offline invariants", () => {
  it("fires exactly one Escape key and nothing else (no paste, no Enter)", async () => {
    const { backend, sends } = recordingBackend();
    const handle = makeHandle(DEPS(backend));

    await handle.interrupt();

    expect(sends).toEqual([{ kind: "key", key: "Escape" }]);
  });

  it("serializes through the per-handle mutex — Escape never interleaves a concurrent send's paste/Enter (case 3)", async () => {
    const { backend, sends } = recordingBackend();
    const handle = makeHandle(DEPS(backend));

    // Fire both without awaiting the first: send wins the mutex (called first),
    // so it must complete its paste+Enter pair before interrupt's Escape lands.
    await Promise.all([handle.send("hello"), handle.interrupt()]);

    const kinds = sends.map((p) => (p.kind === "key" ? p.key : p.kind));
    // send delivers paste→Enter as one contiguous turn; Escape comes after,
    // never wedged between the two halves of the send.
    expect(kinds).toEqual(["paste", "Enter", "Escape"]);
  });

  it("the mutex holds regardless of which verb is invoked first", async () => {
    const { backend, sends } = recordingBackend();
    const handle = makeHandle(DEPS(backend));

    // interrupt first this time: its Escape completes before send's pair starts.
    await Promise.all([handle.interrupt(), handle.send("hello")]);

    const kinds = sends.map((p) => (p.kind === "key" ? p.key : p.kind));
    expect(kinds).toEqual(["Escape", "paste", "Enter"]);
    // The send pair is still contiguous — the Escape didn't split it.
    expect(kinds.slice(1)).toEqual(["paste", "Enter"]);
  });
});
