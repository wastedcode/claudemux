import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex", () => {
  it("serializes overlapping tasks", async () => {
    const m = new Mutex();
    const order: string[] = [];

    const a = m.run(async () => {
      order.push("a-start");
      await new Promise((res) => setTimeout(res, 20));
      order.push("a-end");
      return "a";
    });
    const b = m.run(async () => {
      order.push("b-start");
      await new Promise((res) => setTimeout(res, 5));
      order.push("b-end");
      return "b";
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("releases the mutex when a task rejects", async () => {
    const m = new Mutex();
    await expect(
      m.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The next caller should not be blocked.
    const result = await m.run(async () => 42);
    expect(result).toBe(42);
  });
});
