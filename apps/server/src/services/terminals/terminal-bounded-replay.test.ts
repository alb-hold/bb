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
    args.chunks.push({
      seq: args.nextSeq++,
      dataBase64: Buffer.from(
        Array.from(
          { length: 40 },
          (_, i) =>
            `\x1b[3${i % 8}mrow ${i} ${"wrapped".repeat(20)}\x1b[0m\r\n`,
        ).join(""),
      ).toString("base64"),
    });
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
    const push = vi.spyOn(TerminalScreenState.prototype, "pushBase64");
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
      cells: Array.from({ length: terminal.buffer.active.length }, (_, row) => {
        const line = terminal.buffer.active.getLine(row);
        return {
          wrapped: line?.isWrapped,
          cells: Array.from({ length: terminal.cols }, (_, col) => {
            const cell = line?.getCell(col);
            return [
              cell?.getChars() || " ",
              cell?.getWidth(),
              cell?.getFgColor(),
              cell?.getBgColor(),
              cell?.isBold(),
            ];
          }),
        };
      }),
    });
    try {
      await write(full, updated.chunks);
      await write(restored, incremental.chunks);
      expect(screen(restored)).toEqual(screen(full));
      full.resize(40, 24);
      restored.resize(40, 24);
      expect(screen(restored)).toEqual(screen(full));
      const advanced = await replay.compact(updated);
      expect(
        push.mock.calls.reduce(
          (sum, call) => sum + Buffer.byteLength(call[1], "base64"),
          0,
        ),
      ).toBeLessThan(20_000);
      push.mockRestore();
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
    const warm = vi.spyOn(replay, "compact");
    expect(replay.forAttach(args)).toBe(args);
    expect(warm).toHaveBeenCalledTimes(1);
    const compact = await warm.mock.results[0]!.value;
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

  it("coalesces rapid busy attaches to the latest queued build", async () => {
    const replay = new TerminalBoundedReplay();
    const snapshot = vi.spyOn(TerminalScreenState.prototype, "replaySnapshot");
    const args = input();
    try {
      const requests = Array.from({ length: 20 }, (_, i) =>
        replay.compact({
          ...args,
          nextSeq: args.nextSeq + i,
          chunks: [
            ...args.chunks,
            ...Array.from({ length: i }, (_, j) => ({
              seq: args.nextSeq + j,
              dataBase64: Buffer.from("new\r\n").toString("base64"),
            })),
          ],
        }),
      );
      await Promise.all(requests);
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      snapshot.mockRestore();
      replay.clear();
    }
  });

  it("coalesces busy forAttach warming across event-loop turns", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    await replay.compact(args);
    const snapshot = vi.spyOn(TerminalScreenState.prototype, "replaySnapshot");
    let latest = args;
    try {
      for (let i = 0; i < 20; i++) {
        latest = {
          ...latest,
          chunks: [
            ...latest.chunks,
            {
              seq: latest.nextSeq,
              dataBase64: Buffer.from("new\r\n").toString("base64"),
            },
          ],
          nextSeq: latest.nextSeq + 1,
        };
        replay.forAttach(latest);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await replay.compact(latest);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(replay.forAttach(latest).chunks).toHaveLength(1);
    } finally {
      snapshot.mockRestore();
      replay.clear();
    }
  });

  it("small and incompatible terminals preserve useful compacted entries", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    const warmed = await replay.compact(args);
    for (let i = 0; i < 20; i++) {
      await replay.compact({
        ...input(`small-${i}`),
        chunks: [{ seq: 0, dataBase64: "YQ==" }],
        replayStartSeq: 0,
        nextSeq: 1,
      });
      await replay.compact(input(`incompatible-${i}`, true));
    }
    expect(replay.forAttach(args)).toBe(warmed);
    replay.clear();
  });

  it("refreshes LRU on attach hits", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    const warmed = await replay.compact(args);
    for (let i = 0; i < 16; i++) {
      expect(replay.forAttach(args)).toBe(warmed);
      await replay.compact(input(`other-${i}`));
    }
    expect(replay.forAttach(args)).toBe(warmed);
    replay.clear();
  });

  it("falls back when serialization needs multiple chunks", async () => {
    const replay = new TerminalBoundedReplay();
    const args = input();
    const snapshot = vi
      .spyOn(TerminalScreenState.prototype, "replaySnapshot")
      .mockResolvedValue({
        checkpointSeq: 128,
        dataBase64: Buffer.alloc(100_000, 97).toString("base64"),
      });
    try {
      expect(await replay.compact(args)).toBe(args);
    } finally {
      snapshot.mockRestore();
      replay.clear();
    }
  });

  it("rejects repeat-last-character CSI b", async () => {
    const args = input();
    args.chunks[0]!.dataBase64 = Buffer.from("A\x1b[3b").toString("base64");
    const replay = new TerminalBoundedReplay();
    expect(await replay.compact(args)).toBe(args);
    replay.clear();
  });

  it("serializes builds across distinct terminal identities", async () => {
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
