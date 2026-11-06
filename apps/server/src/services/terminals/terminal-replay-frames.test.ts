import { describe, expect, it } from "vitest";
import {
  terminalServerMessageSchema,
  TERMINAL_REPLAY_BATCH_MAX_BYTES,
} from "@bb/server-contract";
import { terminalReplayFrames } from "./terminal-replay-frames.js";

const chunk = (seq: number, bytes = 1024) => ({
  seq,
  dataBase64: Buffer.alloc(bytes, seq % 256).toString("base64"),
});

const expand = (frames: string[]) =>
  frames.flatMap((frame) => {
    const message = terminalServerMessageSchema.parse(JSON.parse(frame));
    if (message.type === "output") return [message.chunk];
    if (message.type === "output-batch") return message.chunks;
    throw new Error("Unexpected replay frame");
  });

describe("terminal replay frames", () => {
  it("keeps legacy output frames for clients without negotiation", () => {
    const chunks = [chunk(0), chunk(1)];
    const frames = [...terminalReplayFrames(chunks, false)];
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0]!)).toEqual({
      type: "output",
      chunk: chunks[0],
    });
    expect(expand(frames)).toEqual(chunks);
  });

  it("bounds every batch and preserves the original sequence and bytes at byte and count boundaries", () => {
    for (const bytes of [1, 1024, 65536]) {
      const chunks = Array.from(
        { length: bytes === 65536 ? 5 : 1025 },
        (_, seq) => chunk(seq, bytes),
      );
      const frames = [...terminalReplayFrames(chunks, true)];
      expect(
        frames.every(
          (frame) =>
            Buffer.byteLength(frame) <= TERMINAL_REPLAY_BATCH_MAX_BYTES,
        ),
      ).toBe(true);
      expect(expand(frames)).toEqual(chunks);
    }
  });

  it("flushes a partial batch at a sequence gap and at replay end", () => {
    const chunks = [chunk(3), chunk(4), chunk(7)];
    const frames = [...terminalReplayFrames(chunks, true)];
    expect(
      frames.map((frame) =>
        JSON.parse(frame).chunks.map(({ seq }: { seq: number }) => seq),
      ),
    ).toEqual([[3, 4], [7]]);
    expect([...terminalReplayFrames([], true)]).toEqual([]);
  });

  it("keeps split UTF-8 bytes unchanged across batch boundaries", () => {
    const bytes = Buffer.from("A🌍é終B");
    const chunks = Array.from(bytes, (byte, seq) => ({
      seq: seq * 2,
      dataBase64: Buffer.from([byte]).toString("base64"),
    }));
    const frames = [...terminalReplayFrames(chunks, true)];
    expect(frames).toHaveLength(bytes.length);
    expect(
      Buffer.concat(
        expand(frames).map((part) => Buffer.from(part.dataBase64, "base64")),
      ).toString("utf8"),
    ).toBe("A🌍é終B");
  });

  it("rejects empty, oversized and invalid-byte batches at the app boundary", () => {
    for (const chunks of [
      [],
      [chunk(0, 65536), chunk(1, 65536)],
      [{ seq: 0, dataBase64: "!" }],
      ...["AA=A", "A===", "AA", "AAAA=AAA", "ab_c", "YQ==\n"].map(
        (dataBase64) => [{ seq: 0, dataBase64 }],
      ),
    ]) {
      expect(
        terminalServerMessageSchema.safeParse({ type: "output-batch", chunks })
          .success,
      ).toBe(false);
    }
  });
});
