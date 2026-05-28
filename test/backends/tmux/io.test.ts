import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePane } from "../../../src/backends/tmux/capture.js";
import { TmuxExec } from "../../../src/backends/tmux/exec.js";
import { pasteText, sendKey } from "../../../src/backends/tmux/keys.js";
import { getSessionOption, setSessionOption } from "../../../src/backends/tmux/options.js";
import { newSession, targetOf } from "../../../src/backends/tmux/sessions.js";
import { PaneDead, SessionGone } from "../../../src/errors.js";
import { Harness } from "../../harness/index.js";

let h: Harness;
let exec: TmuxExec;
const NS = "iotest";

beforeEach(() => {
  h = Harness.create();
  exec = new TmuxExec(h.socket);
});

afterEach(async () => {
  const leak = await h.teardown();
  expect(leak).toBeNull();
});

/**
 * Spawn a passive sink that writes its stdin to a temp file.
 *
 * `mode: "cooked"` (default for the multi-line test) uses the pty's
 * line-discipline CR→NL translation, so each Enter in the paste body
 * submits a line that cat writes to the sink — matches the receiver-side
 * shape claude (readline-backed) sees.
 *
 * `mode: "raw"` disables line discipline so bytes flow byte-for-byte to
 * cat — used by the "no auto-append Enter" test, where the absence of a
 * trailing newline must be observable even without an EOF.
 */
async function spawnSink(
  name: string,
  mode: "cooked" | "raw" = "cooked",
): Promise<{ target: string; sinkPath: string }> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "claudemux-io-"));
  const sinkPath = join(tmpRoot, "sink");
  const sttyCmd = mode === "raw" ? "stty raw -echo 2>/dev/null;" : "";
  await newSession(exec, {
    namespace: NS,
    name,
    cwd: tmpRoot,
    cmd: "/bin/sh",
    argv: ["-c", `${sttyCmd} cat > ${sinkPath}`],
  });
  await new Promise((res) => setTimeout(res, 100));
  return { target: targetOf(NS, name), sinkPath };
}

describe("pasteText — multi-line, byte-perfect, no Enter auto-append", () => {
  it("multi-line input arrives as one paste with literal newlines (\\r\\n normalized to \\n)", async () => {
    // Cooked-mode sink: tmux's paste delivers \n as \r (terminal Enter shape);
    // the pty's icrnl line discipline turns the \r back into \n on cat's stdin.
    // That two-step round-trip is exactly what claude (readline-style) sees,
    // and what the substrate's normalization decision (research §2) targets.
    const { target, sinkPath } = await spawnSink("multi", "cooked");
    // Trailing \n submits the last line so cooked-mode flushes everything.
    await pasteText(exec, target, "first\r\nsecond\nthird\n");
    await new Promise((res) => setTimeout(res, 300));
    await exec.run(["kill-session", "-t", target], { sessionName: target });
    await new Promise((res) => setTimeout(res, 100));
    const got = readFileSync(sinkPath, "utf8");
    expect(got).toContain("first\nsecond\nthird");
  });

  it("paste does NOT auto-append Enter — sink does not see a trailing newline", async () => {
    // Raw-mode sink: line discipline disabled, so bytes flow without
    // CR/NL translation and without waiting for Enter to submit. In raw
    // mode tmux's \n→\r conversion is visible (\n is delivered as \r) —
    // but the *length* and absence of a trailing line break are what the
    // assertion needs.
    const { target, sinkPath } = await spawnSink("no-enter", "raw");
    await pasteText(exec, target, "no-tail-newline");
    await new Promise((res) => setTimeout(res, 300));
    await exec.run(["kill-session", "-t", target], { sessionName: target });
    await new Promise((res) => setTimeout(res, 100));
    const got = readFileSync(sinkPath, "utf8");
    expect(got).toBe("no-tail-newline");
    expect(got.endsWith("\n")).toBe(false);
    expect(got.endsWith("\r")).toBe(false);
  });

  it("liveness pre-check: paste against a missing session throws SessionGone (not silent drop)", async () => {
    await expect(pasteText(exec, "iotest--never-existed", "hi")).rejects.toThrow(SessionGone);
  });
});

describe("sendKey", () => {
  it("Enter against a live session succeeds", async () => {
    const { target } = await spawnSink("k1");
    await sendKey(exec, target, "Enter");
    await exec.run(["kill-session", "-t", target], { sessionName: target });
  });

  it("pre-check throws SessionGone on missing session", async () => {
    await expect(sendKey(exec, "iotest--never-existed", "Enter")).rejects.toThrow(SessionGone);
  });
});

describe("capturePane — bottom-N, ansi, pane-death", () => {
  it("returns the live visible region (default) — no -S -N invocation", async () => {
    const observed: string[][] = [];
    exec.onCommand((e) => observed.push(e.argv));
    await newSession(exec, {
      namespace: NS,
      name: "cap1",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    observed.length = 0;
    await capturePane(exec, targetOf(NS, "cap1"));
    const captureCall = observed.find((argv) => argv.includes("capture-pane"));
    expect(captureCall).toBeDefined();
    if (!captureCall) return;
    // No `-S` in the argv — the bottom-N trap is avoided by construction.
    expect(captureCall).not.toContain("-S");
  });

  it("opts.lines=N slices in code, not via tmux's -S flag", async () => {
    await newSession(exec, {
      namespace: NS,
      name: "cap-slice",
      cwd: h.sandbox.home,
      cmd: "/bin/sh",
      argv: ["-c", "for i in $(seq 1 60); do echo OL-$i; done; echo OVERFLOW_DONE; sleep 30"],
    });
    await new Promise((res) => setTimeout(res, 300));
    const observed: string[][] = [];
    exec.onCommand((e) => observed.push(e.argv));
    const tail = await capturePane(exec, targetOf(NS, "cap-slice"), { lines: 3 });
    const lines = tail.split("\n").filter((l) => l.length > 0);
    // Should be just the last few non-empty lines of the visible region.
    expect(lines.length).toBeLessThanOrEqual(3);
    const argv = observed.find((a) => a.includes("capture-pane"));
    expect(argv).toBeDefined();
    if (!argv) return;
    expect(argv).not.toContain("-S");
  });

  it("opts.ansi=true adds -e; default does not", async () => {
    await newSession(exec, {
      namespace: NS,
      name: "cap-ansi",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const target = targetOf(NS, "cap-ansi");
    const observed: string[][] = [];
    exec.onCommand((e) => observed.push(e.argv));
    await capturePane(exec, target);
    await capturePane(exec, target, { ansi: true });
    const calls = observed.filter((a) => a.includes("capture-pane"));
    expect(calls).toHaveLength(2);
    const plain = calls[0];
    const ansi = calls[1];
    expect(plain).toBeDefined();
    expect(ansi).toBeDefined();
    if (!plain || !ansi) return;
    expect(plain.includes("-e")).toBe(false);
    expect(ansi.includes("-e")).toBe(true);
  });

  it("surfaces PaneDead from the Case-A annotation", async () => {
    await newSession(exec, {
      namespace: NS,
      name: "cap-dead",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const target = targetOf(NS, "cap-dead");
    await exec.run(["set-window-option", "-t", target, "remain-on-exit", "on"], {
      sessionName: target,
    });
    const pidR = await exec.run(["display-message", "-p", "-t", target, "#{pane_pid}"], {
      sessionName: target,
    });
    process.kill(Number(pidR.stdout.trim()), "SIGKILL");
    await new Promise((res) => setTimeout(res, 300));
    await expect(capturePane(exec, target)).rejects.toThrow(PaneDead);
    await exec.run(["kill-session", "-t", target], { sessionName: target });
  });
});

describe("session metadata — set/get round-trip (the cross-process send-baseline store)", () => {
  it("round-trips a value, overwrites it, and returns undefined for an unset key", async () => {
    await newSession(exec, {
      namespace: NS,
      name: "meta1",
      cwd: h.sandbox.home,
      cmd: "sleep",
      argv: ["60"],
    });
    const target = targetOf(NS, "meta1");
    const fp = "deadbeef".repeat(8); // 64-char, sha256-hex shaped

    // Unset → undefined (not an error — it's optional metadata).
    expect(await getSessionOption(exec, target, "send-baseline")).toBeUndefined();
    // Set → reads back verbatim.
    await setSessionOption(exec, target, "send-baseline", fp);
    expect(await getSessionOption(exec, target, "send-baseline")).toBe(fp);
    // Overwrite → latest value wins (each send replaces the baseline).
    await setSessionOption(exec, target, "send-baseline", "cafef00d");
    expect(await getSessionOption(exec, target, "send-baseline")).toBe("cafef00d");

    await exec.run(["kill-session", "-t", target], { sessionName: target });
  });

  it("getSessionOption returns undefined for a missing session (best-effort, never throws)", async () => {
    expect(
      await getSessionOption(exec, targetOf(NS, "never-existed"), "send-baseline"),
    ).toBeUndefined();
  });
});
