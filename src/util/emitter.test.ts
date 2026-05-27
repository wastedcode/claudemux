import { describe, expect, it } from "vitest";
import { Emitter } from "./emitter.js";

describe("Emitter", () => {
  it("fans out emit() to every subscriber", () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    e.on((v) => seen.push(v));
    e.on((v) => seen.push(v * 10));
    e.emit(1);
    e.emit(2);
    expect(seen).toEqual([1, 10, 2, 20]);
  });

  it("the unsubscribe fn removes the subscriber", () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    const off = e.on((v) => seen.push(v));
    e.emit(1);
    off();
    e.emit(2);
    expect(seen).toEqual([1]);
    expect(e.size).toBe(0);
  });

  it("isolates subscriber errors", () => {
    const e = new Emitter<void>();
    let secondFired = false;
    e.on(() => {
      throw new Error("boom");
    });
    e.on(() => {
      secondFired = true;
    });
    expect(() => {
      e.emit();
    }).not.toThrow();
    expect(secondFired).toBe(true);
  });
});
