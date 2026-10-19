import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createTerminalSession } from "../../src/data/terminal-sessions.js";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendRetainedTerminalOutputChunk,
  appendRetainedTerminalOutputChunks,
  TERMINAL_RETAINED_OUTPUT_BYTES,
} from "../../src/fork-terminal-output.js";
import { createTerminalGridMarker } from "@bb/domain";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "replay-benchmark" });
  const terminal = createTerminalSession(db, {
    cols: 80,
    daemonSessionId: null,
    environmentId: null,
    hostId: host.id,
    initialCwd: "/tmp",
    rows: 24,
    status: "running",
    threadId: null,
    title: "replay benchmark",
    now: 1,
  });
  return { db, host, terminal };
}

function replayChunks(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const content = `chunk-${String(index).padStart(5, "0")}-`;
    const plain = Buffer.from(content + "x".repeat(200 - content.length));
    const data =
      index % 997 === 0
        ? Buffer.concat([
            plain.subarray(0, 20),
            Buffer.from(createTerminalGridMarker({ cols: 80, rows: 24 })),
            plain.subarray(20),
          ])
        : plain;
    return { seq: index, dataBase64: data.toString("base64") };
  });
}

describe("retained terminal output replay", () => {
  it("matches per-chunk retention for a large replay and retains it within the timing bound", () => {
    const chunks = replayChunks(10_000);
    const perChunk = setup();
    const perChunkStartedAt = performance.now();
    for (const chunk of chunks) {
      appendRetainedTerminalOutputChunk(perChunk.db, {
        hostId: perChunk.host.id,
        terminalSessionId: perChunk.terminal.id,
        chunk,
        now: 2,
      });
    }
    const perChunkMs = performance.now() - perChunkStartedAt;
    const expected = perChunk.db.$client
      .prepare(
        "SELECT chunks_json AS chunksJson, byte_length AS byteLength FROM fork_terminal_output WHERE terminal_session_id = ?",
      )
      .get(perChunk.terminal.id) as { chunksJson: string; byteLength: number };

    const batched = setup();
    const startedAt = performance.now();
    appendRetainedTerminalOutputChunks(batched.db, {
      hostId: batched.host.id,
      terminalSessionId: batched.terminal.id,
      chunks,
      now: 2,
    });
    const elapsedMs = performance.now() - startedAt;
    const row = batched.db.$client
      .prepare(
        "SELECT chunks_json AS chunksJson, byte_length AS byteLength FROM fork_terminal_output WHERE terminal_session_id = ?",
      )
      .get(batched.terminal.id) as { chunksJson: string; byteLength: number };
    process.stdout.write(
      `retained replay 10000 chunks: batched ${elapsedMs.toFixed(1)}ms, per-chunk reference ${perChunkMs.toFixed(1)}ms; json=${Buffer.byteLength(row.chunksJson)} bytes; retained=${row.byteLength} bytes\n`,
    );
    expect(row).toEqual(expected);
    expect(row.byteLength).toBe(65_421);
    expect(JSON.parse(row.chunksJson)[0].leadingGridMarker).toBe(
      createTerminalGridMarker({ cols: 80, rows: 24 }),
    );
    expect(elapsedMs).toBeLessThan(2_000);
  }, 60_000);

  const marker = createTerminalGridMarker({ cols: 80, rows: 24 });
  const chunkOf = (seq: number, text: string) => ({
    seq,
    dataBase64: Buffer.from(text).toString("base64"),
  });
  const filled = (from: number, count: number, size: number) =>
    Array.from({ length: count }, (_, index) =>
      chunkOf(from + index, `${from + index}:`.padEnd(size, "y")),
    );
  const atCap = filled(0, TERMINAL_RETAINED_OUTPUT_BYTES / 256, 256);

  it.each([
    {
      name: "a short replay into an empty buffer",
      existing: [],
      replay: filled(0, 20, 200),
    },
    {
      name: "a buffer exactly at the cap, then a replay crossing it",
      existing: atCap,
      replay: [
        chunkOf(atCap.length, `${marker}after the cap`),
        ...filled(atCap.length + 1, 300, 256),
      ],
    },
    {
      name: "a buffer one byte under the cap, then a replay crossing it by one byte and then far",
      existing: [...filled(0, 255, 256), chunkOf(255, "z".repeat(255))],
      replay: [chunkOf(256, "ab"), ...filled(257, 40, 1024)],
    },
    {
      name: "a replay holding one chunk larger than the cap, with a grid marker in the cut prefix",
      existing: filled(0, 10, 256),
      replay: [
        chunkOf(10, `${marker}${"p".repeat(1_000)}${"q".repeat(TERMINAL_RETAINED_OUTPUT_BYTES + 500)}`),
        ...filled(11, 5, 256),
      ],
    },
    {
      name: "a replay repeating a sequence after the cap trim evicted it",
      existing: filled(0, 4, 256),
      replay: [
        chunkOf(4, "first copy of sequence 4"),
        ...filled(5, 300, 256),
        chunkOf(4, "second copy of sequence 4, after its eviction"),
        ...filled(305, 3, 256),
      ],
    },
    {
      name: "a replay repeating an evicted sequence from the existing buffer",
      existing: filled(0, 4, 256),
      replay: [...filled(4, 300, 256), chunkOf(1, "sequence 1 again")],
    },
    {
      name: "a replay overlapping sequences already retained, crossing the cap",
      existing: filled(0, 200, 256),
      replay: filled(150, 200, 256),
    },
  ])("retains byte-identical output to the per-chunk path: $name", ({ existing, replay }) => {
    const reference = setup();
    const batched = setup();
    for (const target of [reference, batched]) {
      for (const chunk of existing) {
        appendRetainedTerminalOutputChunk(target.db, {
          hostId: target.host.id,
          terminalSessionId: target.terminal.id,
          chunk,
          now: 2,
        });
      }
    }
    for (const chunk of replay) {
      appendRetainedTerminalOutputChunk(reference.db, {
        hostId: reference.host.id,
        terminalSessionId: reference.terminal.id,
        chunk,
        now: 3,
      });
    }
    appendRetainedTerminalOutputChunks(batched.db, {
      hostId: batched.host.id,
      terminalSessionId: batched.terminal.id,
      chunks: replay,
      now: 3,
    });
    const read = (target: ReturnType<typeof setup>) =>
      target.db.$client
        .prepare(
          "SELECT chunks_json AS chunksJson, byte_length AS byteLength, retained_at AS retainedAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(target.terminal.id) as
        | { chunksJson: string; byteLength: number; retainedAt: number }
        | undefined;
    const expected = read(reference);
    expect(expected?.byteLength).toBeGreaterThan(0);
    expect(expected?.byteLength).toBeLessThanOrEqual(
      TERMINAL_RETAINED_OUTPUT_BYTES,
    );
    expect(read(batched)).toEqual(expected);
  });
});
