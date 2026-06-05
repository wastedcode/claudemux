import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * An incremental line reader for an **append-only** file (a hook rendezvous or a
 * transcript). Each {@link poll} reads only the bytes appended since the last
 * call and returns the new *complete* lines — so a long-lived session's
 * `progress()`/`wait()` re-parse O(delta) per poll instead of O(file) (the
 * unbounded-growth trap, F39). A trailing partial line (mid-flush write) is held
 * back and completed on the next poll.
 *
 * Correct ONLY for append-only files: it trusts that bytes before its offset
 * never change. If the file **shrinks** (truncation / rotation / an overwrite to
 * a shorter body) it resets and re-reads from the start, signalling `reset` so
 * the caller can discard whatever it accumulated. A claude transcript/rendezvous
 * is append-only by construction (compaction summarizes the context window, it
 * never rewrites the log), so the reset path is purely defensive.
 */
export class TailReader {
  #offset = 0;
  #partial = "";

  /**
   * The new complete lines since the last poll. `reset: true` means the file
   * shrank and `lines` is the WHOLE file again — the caller must drop its
   * accumulated state first. Absent/unreadable file → no change (`[]`).
   */
  poll(path: string): { reset: boolean; lines: string[] } {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { reset: false, lines: [] }; // absent — degrade, never throw
    }
    let reset = false;
    if (size < this.#offset) {
      this.#offset = 0;
      this.#partial = "";
      reset = true;
    }
    if (size <= this.#offset) return { reset, lines: [] };

    const fd = openSync(path, "r");
    try {
      const len = size - this.#offset;
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, this.#offset);
      this.#offset += n;
      const chunk = this.#partial + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split("\n");
      this.#partial = lines.pop() ?? ""; // last element = an incomplete line → hold
      return { reset, lines };
    } finally {
      closeSync(fd);
    }
  }
}
