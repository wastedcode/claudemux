import { describe, expect, it } from "vitest";
import { sanitizePasteBody } from "./keys.js";

describe("sanitizePasteBody — paste-injection defense (F48)", () => {
  it("removes the bracketed-paste END marker so a body can't close the bracket early", () => {
    // Without this, ESC[201~ ends the paste and `\n rm -rf` submits as typed input.
    const evil = "look at this\x1b[201~\nrm -rf /";
    const out = sanitizePasteBody(evil);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("[201~");
    expect(out).toBe("look at this\nrm -rf /"); // the marker gone; text + newline kept
  });

  it("strips the start marker and bare ESC sequences too", () => {
    expect(sanitizePasteBody("\x1b[200~hi\x1b[31mred\x1b[0m")).toBe("hi[31mred[0m");
  });

  it("keeps newlines and tabs (legitimate prompt content)", () => {
    expect(sanitizePasteBody("a\tb\nc")).toBe("a\tb\nc");
  });

  it("normalizes CRLF and lone CR to \\n (a lone \\r becomes a newline, not deleted)", () => {
    expect(sanitizePasteBody("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("drops other C0 control bytes (NUL, BEL, backspace) and DEL", () => {
    expect(sanitizePasteBody("a\x00b\x07c\x08d\x7fe")).toBe("abcde");
  });

  it("leaves plain text untouched", () => {
    expect(sanitizePasteBody("Reply with exactly: PONG")).toBe("Reply with exactly: PONG");
  });
});
