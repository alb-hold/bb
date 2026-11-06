import { Buffer } from "node:buffer";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { TerminalBoundedReplay } from "./terminal-bounded-replay.js";
import { TerminalScreenState } from "./terminal-screen-state.js";

function input(terminalId = "terminal", incompatible = false) {
  const chunks = Array.from({ length: 128 }, (_, seq) => ({
    seq: 6911 + seq,
    dataBase64: Buffer.from(
      `${incompatible ? "\x1b[?1049h" : ""}\x1b[H${"frame\r".repeat(1000)}`,
    ).toString("base64"),
  }));
  return {
    terminalId,
    daemonSessionId: "daemon",
    cols: 80,
    rows: 24,
    replayStartSeq: 6911,
    nextSeq: 6911 + chunks.length,
    chunks,
  };
}

describe("bounded replay scheduling", () => {
  it("reuses a warmed snapshot plus only new output for an active terminal", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    expect(replay.forAttach(args)).toBe(args);
    const snapshot = await replay.compact(args);
    const suffix = Array.from({ length: 3 }, (_, i) => ({
      seq: args.nextSeq + i,
      dataBase64: Buffer.from(`\r\nnew ${i}`).toString("base64"),
    }));
    const updated = {
      ...args,
      chunks: [...args.chunks, ...suffix],
      nextSeq: args.nextSeq + suffix.length,
    };
    const incremental = replay.forAttach(updated);
    expect(incremental.chunks).toEqual([...snapshot.chunks, ...suffix]);
    const shifted = replay.forAttach({
      ...updated,
      replayStartSeq: args.replayStartSeq + 1,
      chunks: updated.chunks.slice(1),
    });
    expect(shifted.chunks).toEqual(incremental.chunks);
    const full = new Terminal({
      cols: args.cols,
      rows: args.rows,
      allowProposedApi: true,
    });
    const restored = new Terminal({
      cols: args.cols,
      rows: args.rows,
      allowProposedApi: true,
    });
    const write = (terminal: Terminal, chunks: typeof args.chunks) =>
      new Promise<void>((resolve) =>
        terminal.write(
          Buffer.concat(chunks.map((c) => Buffer.from(c.dataBase64, "base64"))),
          resolve,
        ),
      );
    const screen = (terminal: Terminal) => ({
      rows: Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true),
      ),
      cursor: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY],
      modes: terminal.modes,
    });
    try {
      await write(full, updated.chunks);
      await write(restored, incremental.chunks);
      expect(screen(restored)).toEqual(screen(full));
      full.resize(40, 24);
      restored.resize(40, 24);
      expect(screen(restored)).toEqual(screen(full));
      const advanced = await replay.compact(updated);
      expect(replay.forAttach(updated)).toBe(advanced);
    } finally {
      full.dispose();
      restored.dispose();
      replay.clear();
    }
  });
  it("serves a cold attach immediately while warming the replay for the next attach", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    expect(replay.forAttach(args)).toBe(args);
    const compact = await replay.compact(args);
    expect(compact.chunks.length).toBeLessThan(args.chunks.length);
    expect(replay.forAttach(args)).toBe(compact);
    replay.clear();
    expect(replay.forAttach(args)).toBe(args);
    replay.clear();
  });
  it("pushes separate chunks, caches incompatible replay and skips parsing it", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input("incompatible", true);
    const push = vi.spyOn(TerminalScreenState.prototype, "pushBase64");
    const original = TerminalScreenState.prototype.replaySnapshot;
    let writes = 0;
    const snapshot = vi
      .spyOn(TerminalScreenState.prototype, "replaySnapshot")
      .mockImplementation(async function (this: TerminalScreenState) {
        const terminal: unknown = Reflect.get(this, "terminal");
        if (!(terminal instanceof Terminal))
          throw new Error("missing terminal");
        const write = vi.spyOn(terminal, "write");
        try {
          return await original.call(this);
        } finally {
          writes += write.mock.calls.length;
          write.mockRestore();
        }
      });
    try {
      expect(await replay.compact(args)).toBe(args);
      expect(push).toHaveBeenCalledTimes(args.chunks.length);
      expect(await replay.compact(args)).toBe(args);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(writes).toBe(0);
    } finally {
      push.mockRestore();
      snapshot.mockRestore();
    }
  });

  it("caps builds at one across distinct terminal attaches", async () => {
    const replay = new TerminalBoundedReplay();
    const original = TerminalScreenState.prototype.replaySnapshot;
    let active = 0;
    let maximum = 0;
    const snapshot = vi
      .spyOn(TerminalScreenState.prototype, "replaySnapshot")
      .mockImplementation(async function (this: TerminalScreenState) {
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          return await original.call(this);
        } finally {
          active -= 1;
        }
      });
    try {
      await Promise.all([
        replay.compact(input("a")),
        replay.compact(input("b")),
        replay.compact(input("c")),
      ]);
      expect(maximum).toBe(1);
    } finally {
      snapshot.mockRestore();
    }
  });
});
