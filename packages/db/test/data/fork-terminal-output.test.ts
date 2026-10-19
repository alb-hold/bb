import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createTerminalSession } from "../../src/data/terminal-sessions.js";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendRetainedTerminalOutputChunk,
  appendRetainedTerminalOutputChunks,
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
    for (const chunk of chunks) {
      appendRetainedTerminalOutputChunk(perChunk.db, {
        hostId: perChunk.host.id,
        terminalSessionId: perChunk.terminal.id,
        chunk,
        now: 2,
      });
    }
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
      `retained replay 10000 chunks: ${elapsedMs.toFixed(1)}ms; json=${Buffer.byteLength(row.chunksJson)} bytes; retained=${row.byteLength} bytes\n`,
    );
    expect(row).toEqual(expected);
    expect(row.byteLength).toBe(65_421);
    expect(JSON.parse(row.chunksJson)[0].leadingGridMarker).toBe(
      createTerminalGridMarker({ cols: 80, rows: 24 }),
    );
    expect(elapsedMs).toBeLessThan(2_000);
  }, 60_000);
});
