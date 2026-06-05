import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TailReader } from "./incremental.js";

describe("TailReader — incremental append-only reads (bounded per poll)", () => {
  let dir: string;
  let f: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmux-tail-"));
    f = join(dir, "log");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns only the NEW complete lines on each poll", () => {
    const r = new TailReader();
    writeFileSync(f, "a\nb\n");
    expect(r.poll(f)).toEqual({ reset: false, lines: ["a", "b"] });
    appendFileSync(f, "c\n");
    expect(r.poll(f)).toEqual({ reset: false, lines: ["c"] }); // only the delta
    expect(r.poll(f)).toEqual({ reset: false, lines: [] }); // nothing new
  });

  it("holds back a trailing partial line until it is completed", () => {
    const r = new TailReader();
    writeFileSync(f, "comp"); // no trailing newline → incomplete
    expect(r.poll(f)).toEqual({ reset: false, lines: [] }); // partial held
    appendFileSync(f, "lete\nnext\n");
    expect(r.poll(f)).toEqual({ reset: false, lines: ["complete", "next"] });
  });

  it("resets and re-reads the whole file when it shrinks (truncation/rotation)", () => {
    const r = new TailReader();
    writeFileSync(f, "old1\nold2\nold3\n");
    expect(r.poll(f).lines).toEqual(["old1", "old2", "old3"]);
    writeFileSync(f, "fresh\n"); // shorter → shrink
    expect(r.poll(f)).toEqual({ reset: true, lines: ["fresh"] });
  });

  it("absent file → no change, never throws", () => {
    const r = new TailReader();
    expect(r.poll(join(dir, "nope"))).toEqual({ reset: false, lines: [] });
  });
});
