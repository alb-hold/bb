import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderTerminalMirrorSnapshot,
  renderTerminalScreen,
} from "./terminal-screen.js";
import { TerminalScreenMirror } from "./terminal-screen-mirror.js";
import { terminalScreenMirrorWorkerSource } from "./terminal-screen-mirror-worker-source.js";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const mirrors: TerminalScreenMirror[] = [];

function createMirror(workerFactory?: () => Worker): TerminalScreenMirror {
  const mirror = new TerminalScreenMirror(() => undefined, workerFactory);
  mirrors.push(mirror);
  return mirror;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

afterEach(async () => {
  await Promise.all(mirrors.splice(0).map((mirror) => mirror.shutdown()));
});

describe("TerminalScreenMirror", () => {
  it("keeps the top separator row and reports a complete mirror screen", async () => {
    const frame = Array.from({ length: 24 }, (_, row) =>
      row === 11
        ? ""
        : `\u001b[${row + 1};1H${`top frame 99 row ${row}`.padEnd(80)}\u001b[K`,
    ).join("");
    const stream = Buffer.from(`${frame.repeat(100)}\u001b[24;1H`);
    const mirror = createMirror();
    mirror.start("top", 80, 24);
    for (let offset = 0, seq = 0; offset < stream.length; offset += 64 * 1024, seq += 1) {
      mirror.write("top", seq, stream.subarray(offset, offset + 64 * 1024));
    }
    const snapshot = await mirror.snapshot("top");
    expect(snapshot).not.toBeNull();
    const screen = renderTerminalMirrorSnapshot({
      lines: undefined,
      snapshot: snapshot!,
      truncated: true,
    });
    const replay = await renderTerminalScreen({
      cols: 80,
      lines: undefined,
      output: {
        chunks: [{ seq: 0, dataBase64: stream.toString("base64") }],
        nextSeq: 1,
        truncated: false,
        status: "running",
        exitCode: null,
        closeReason: null,
      },
      rows: 24,
    });
    expect(screen.complete).toBe(true);
    expect(screen.rows).toEqual(replay.rows);
    expect(screen.rows[11]).toBe("");
  });

  it("deduplicates direct and socket output by sequence", async () => {
    const mirror = createMirror();
    mirror.start("dual", 20, 2);
    mirror.write("dual", 0, bytes("once"));
    mirror.write("dual", 0, bytes("once"));
    const snapshot = await mirror.snapshot("dual");
    expect(snapshot?.bufferRows[snapshot.baseY]).toBe("once");
  });

  it("orders resize between output chunks", async () => {
    const mirror = createMirror();
    mirror.start("resize", 4, 2);
    mirror.write("resize", 0, bytes("xy"));
    mirror.resize("resize", 3, 3);
    mirror.write("resize", 1, bytes("\u001b[2;1Hz"));
    const snapshot = await mirror.snapshot("resize");
    expect(snapshot).toMatchObject({ cols: 3, gridRows: 3 });
    expect(snapshot?.bufferRows.slice(snapshot.baseY, snapshot.baseY + 3)).toEqual([
      "xy",
      "z",
      "",
    ]);
  });

  it("parses the final queued chunk before disposal", async () => {
    const mirror = createMirror();
    mirror.start("final", 20, 2);
    mirror.write("final", 0, bytes("final chunk"));
    const snapshot = await mirror.snapshot("final");
    expect(snapshot?.bufferRows[snapshot.baseY]).toBe("final chunk");
    mirror.dispose("final");
    expect(await mirror.snapshot("final")).toBeNull();
  });

  it("uses the truncated replay result after process restart", async () => {
    const mirror = createMirror();
    expect(await mirror.snapshot("restarted")).toBeNull();
    const replay = await renderTerminalScreen({
      cols: 20,
      lines: undefined,
      output: {
        chunks: [{ seq: 10, dataBase64: Buffer.from("partial\n").toString("base64") }],
        nextSeq: 11,
        truncated: true,
        status: "running",
        exitCode: null,
        closeReason: null,
      },
      rows: 2,
    });
    expect(replay.complete).toBe(false);
    expect(replay.truncated).toBe(true);
  });

  it("falls back after overflow until a full RIS reset", async () => {
    const mirror = createMirror();
    mirror.start("overflow", 80, 24);
    const data = new Uint8Array(64 * 1024).fill(0x78);
    for (let seq = 0; seq < 272; seq += 1) mirror.write("overflow", seq, data);
    expect(await mirror.snapshot("overflow")).toBeNull();
    mirror.write("overflow", 272, bytes("\u001bcreset"));
    const snapshot = await mirror.snapshot("overflow");
    expect(snapshot?.bufferRows[snapshot.baseY]).toContain("reset");
  });

  it("keeps 128 sessions and a 129th session available", async () => {
    const mirror = createMirror();
    for (let index = 0; index < 129; index += 1) {
      const id = `cap-${index}`;
      mirror.start(id, 20, 2);
      mirror.write(id, 0, bytes(`session-${index}`));
    }
    const screens = await Promise.all(
      Array.from({ length: 129 }, (_, index) => mirror.snapshot(`cap-${index}`)),
    );
    expect(screens).toHaveLength(129);
    expect(screens.every((screen) => screen !== null)).toBe(true);
  });

  it("rejects a stale generation and uses replay when the worker exits", async () => {
    let worker: Worker | null = null;
    const mirror = createMirror(() => {
      worker = new Worker(terminalScreenMirrorWorkerSource, {
        eval: true,
        workerData: {
          headlessPath: require.resolve("@xterm/headless"),
          scrollback: 500,
          unicodeAddonPath: require.resolve("@xterm/addon-unicode11"),
        },
      });
      return worker!;
    });
    mirror.start("generation", 20, 2);
    mirror.write("generation", 0, bytes("old"));
    const stale = mirror.snapshot("generation");
    mirror.start("generation", 20, 2);
    expect(await stale).toBeNull();
    expect(worker).not.toBeNull();
    await worker!.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await mirror.snapshot("generation")).toBeNull();
    const replay = await renderTerminalScreen({
      cols: 20,
      lines: undefined,
      output: {
        chunks: [{ seq: 0, dataBase64: Buffer.from("tail\n").toString("base64") }],
        nextSeq: 1,
        truncated: true,
        status: "running",
        exitCode: null,
        closeReason: null,
      },
      rows: 2,
    });
    expect(replay.complete).toBe(false);
  });
});
