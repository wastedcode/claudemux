import { describe, expect, it, vi } from "vitest";
import { ask } from "./compose.js";
import type { Message, SessionHandle, TurnOutcome } from "./types.js";

/** A SessionHandle stub recording call ORDER — ask must send → wait → read. */
function stubHandle(
  outcome: TurnOutcome,
  messages: Message[],
): { handle: SessionHandle; order: string[] } {
  const order: string[] = [];
  const handle = {
    name: "t",
    namespace: "ns",
    send: vi.fn(async () => {
      order.push("send");
      return "cursor-1";
    }),
    wait: vi.fn(async () => {
      order.push("wait");
      return outcome;
    }),
    messagesSince: vi.fn(async (c: string) => {
      order.push(`messagesSince:${c}`);
      return messages;
    }),
  } as unknown as SessionHandle;
  return { handle, order };
}

const reply: Message[] = [{ id: "a1", role: "assistant", parts: [{ kind: "text", text: "4" }] }];

describe("ask — the Q&A round-trip composer", () => {
  it("sequences send → wait → messagesSince and returns the full result", async () => {
    const { handle, order } = stubHandle({ kind: "completed" }, reply);
    const r = await ask(handle, "2+2?");
    expect(order).toEqual(["send", "wait", "messagesSince:cursor-1"]);
    expect(r).toEqual({ outcome: { kind: "completed" }, messages: reply, cursor: "cursor-1" });
  });

  it("surfaces the FULL outcome on an abnormal turn (never swallows the union)", async () => {
    const { handle } = stubHandle({ kind: "awaiting", on: "permission-prompt" }, []);
    const r = await ask(handle, "rm -rf?");
    expect(r.outcome).toEqual({ kind: "awaiting", on: "permission-prompt" });
    expect(r.cursor).toBe("cursor-1"); // the cursor is always returned for a later re-read
  });

  it("threads ReadyOpts through to wait()", async () => {
    const { handle } = stubHandle({ kind: "budget-exceeded", reason: "max" }, []);
    await ask(handle, "slow", { timeoutMs: 1234 });
    expect(handle.wait).toHaveBeenCalledWith({ timeoutMs: 1234 });
  });
});
