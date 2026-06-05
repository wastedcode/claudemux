import { describe, expect, it, vi } from "vitest";
import { ask, recover } from "./compose.js";
import { SessionExists, SessionGone } from "./errors.js";
import { adopt } from "./session/adopt.js";
import { resume } from "./session/resume.js";
import type { Message, SessionHandle, TurnOutcome } from "./types.js";

vi.mock("./session/adopt.js", () => ({ adopt: vi.fn() }));
vi.mock("./session/resume.js", () => ({ resume: vi.fn() }));
const mockAdopt = vi.mocked(adopt);
const mockResume = vi.mocked(resume);

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

describe("recover — the reconnect compound (adopt-or-resume, report which)", () => {
  const opts = { name: "job", cwd: "/tmp/x", agentSessionId: "id-1" };
  const fakeHandle = (n: string) => ({ name: n }) as unknown as SessionHandle;

  it("pane ALIVE → adopt succeeds → status 'attached', resume NOT called", async () => {
    const live = fakeHandle("live");
    mockAdopt.mockReset().mockResolvedValue(live);
    mockResume.mockReset();
    const r = await recover(opts);
    expect(r.status).toBe("attached");
    expect(r.session).toBe(live); // the adopted handle, untouched
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("pane GONE (adopt throws SessionGone) → resume → status 'resumed'", async () => {
    mockAdopt.mockReset().mockRejectedValue(new SessionGone("job"));
    mockResume.mockReset().mockResolvedValue(fakeHandle("fresh"));
    const r = await recover(opts);
    expect(r.status).toBe("resumed");
    expect(mockResume).toHaveBeenCalledWith(opts); // the full resume opts threaded through
  });

  it("a NON-crash adopt error propagates — resume is NOT a catch-all", async () => {
    mockAdopt.mockReset().mockRejectedValue(new SessionExists("job"));
    mockResume.mockReset();
    await expect(recover(opts)).rejects.toBeInstanceOf(SessionExists);
    expect(mockResume).not.toHaveBeenCalled();
  });
});
