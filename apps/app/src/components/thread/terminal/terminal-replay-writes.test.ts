import { describe, expect, it } from "vitest";
import { terminalReplayWrites } from "./terminal-replay-writes";
import { createTerminalOutputBoundaries } from "./terminal-output-boundaries";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";

describe("terminal replay writes", () => {
  it("bounds xterm writes for one maximum-size retained chunk and holds its callback", async () => {
    const callbacks: Array<() => void> = [];
    const sizes: number[] = [];
    let parsed = false;
    const pipeline = createTerminalOutputPipeline({
      resize() {},
      write(bytes, callback) {
        sizes.push(bytes.length);
        callbacks.push(callback);
      },
    });
    const chunk = {
      seq: 0,
      dataBase64: Buffer.alloc(65536, 65).toString("base64"),
    };
    for (const write of terminalReplayWrites([chunk]))
      pipeline.push(write.bytes, () => {
        parsed = true;
      });
    expect(sizes).toEqual([16384, 16384, 16384, 16384]);
    for (const callback of callbacks.slice(0, -1)) callback();
    await Promise.resolve();
    expect(parsed).toBe(false);
    callbacks.at(-1)!();
    await Promise.resolve();
    expect(parsed).toBe(true);
  });
  it("coalesces decoded bytes into bounded writes while retaining sequence fences", () => {
    const chunks = Array.from({ length: 35 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.alloc(1024, seq).toString("base64"),
    }));
    const writes = [...terminalReplayWrites(chunks)];
    expect(
      writes.map((write) => [write.chunk.seq, write.bytes.length]),
    ).toEqual([
      [15, 16384],
      [31, 16384],
      [34, 3072],
    ]);
    expect(Buffer.concat(writes.map((write) => write.bytes))).toEqual(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
      ),
    );
  });

  it("preserves split UTF-8 and control strings across batches and snapshot checkpoints", () => {
    const data = Buffer.from("A".repeat(16383) + "🌍\u001b]52;c;YWJj\u0007終");
    const chunks = Array.from(data, (byte, seq) => ({
      seq,
      dataBase64: Buffer.from([byte]).toString("base64"),
    }));
    const writes = [...terminalReplayWrites(chunks, undefined, 16385)];
    expect(writes.map((write) => write.chunk.seq)).toEqual([
      16383,
      16384,
      data.length - 1,
    ]);
    expect(Buffer.concat(writes.map((write) => write.bytes))).toEqual(data);
  });

  it("keeps each source boundary in the visible stream and omits boundaries from the preview stream", () => {
    const chunks = ["\u001b]52;c;", "YWJj\u0007", "done"].map((text, seq) => ({
      seq,
      dataBase64: Buffer.from(text).toString("base64"),
    }));
    const oracle = createTerminalOutputBoundaries("test");
    const expected = Buffer.concat(
      chunks.map((chunk) =>
        oracle.insert(Buffer.from(chunk.dataBase64, "base64"), chunk.seq),
      ),
    );
    const writes = [
      ...terminalReplayWrites(chunks, createTerminalOutputBoundaries("test")),
    ];
    expect(Buffer.concat(writes.map((write) => write.bytes))).toEqual(expected);
    expect(
      Buffer.concat(writes.map((write) => write.sourceBytes)).toString(),
    ).toBe("\u001b]52;c;YWJj\u0007done");
    expect([...terminalReplayWrites([])]).toEqual([]);
  });
});
