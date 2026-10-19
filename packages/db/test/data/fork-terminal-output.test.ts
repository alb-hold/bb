import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createTerminalSession } from "../../src/data/terminal-sessions.js";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendRetainedTerminalOutputChunk,
  appendRetainedTerminalOutputChunks,
  HOST_RETAINED_OUTPUT_BYTES,
  HOST_RETAINED_TERMINAL_LIMIT,
  markRetainedTerminalOutputExited,
  TERMINAL_OUTPUT_RETENTION_MS,
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

  function seededRandom(seed: number) {
    let state = seed >>> 0;
    return (limit: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % limit;
    };
  }

  function buildScenario(seed: number, pressure: boolean) {
    const random = seededRandom(seed);
    const text = (seq: number, size: number) =>
      `${random(4) === 0 ? marker : ""}${seq}:`.padEnd(size, String.fromCharCode(97 + random(26)));
    const sessionCount = pressure ? 30 + random(120) : 1 + random(20);
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      chunks: Array.from({ length: 1 + random(pressure ? 40 : 6) }, (_, seq) =>
        chunkOf(seq, text(seq, 1 + random(pressure ? 4_000 : 1_500))),
      ),
      retainedAt: 2 + random(50),
      expired: random(5) === 0,
      ownedByTarget: index === 0,
    }));
    const otherHostExpired = random(3) === 0 ? 0 : 1 + random(400);
    const replayLength = 1 + random(250);
    const replay = Array.from({ length: replayLength }, (_, index) => {
      const seq =
        random(10) === 0 ? random(index + 10) : 1_000 + index;
      if (random(60) === 0) {
        return chunkOf(seq, text(seq, TERMINAL_RETAINED_OUTPUT_BYTES + 1 + random(3_000)));
      }
      return chunkOf(seq, text(seq, 1 + random(2_000)));
    });
    return { sessions, otherHostExpired, replay };
  }

  type Scenario = ReturnType<typeof buildScenario>;

  function runScenario(scenario: Scenario, mode: "per-chunk" | "batched") {
    const db = createMigratedConnection();
    const host = upsertHost(db, noopNotifier, { name: "target" });
    const otherHost = upsertHost(db, noopNotifier, { name: "other" });
    const replayNow = 100 + TERMINAL_OUTPUT_RETENTION_MS;
    const create = (hostId: string, label: number) =>
      createTerminalSession(db, {
        cols: 80,
        daemonSessionId: null,
        environmentId: null,
        hostId,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: null,
        title: `session ${label}`,
        now: 1,
      });
    const labels = new Map<string, string>([
      [host.id, "host:target"],
      [otherHost.id, "host:other"],
    ]);
    for (let index = 0; index < scenario.otherHostExpired; index += 1) {
      const terminal = create(otherHost.id, index);
      labels.set(terminal.id, `other:${index}`);
      appendRetainedTerminalOutputChunk(db, {
        hostId: otherHost.id,
        terminalSessionId: terminal.id,
        chunk: chunkOf(0, `other host ${index}`),
        now: 2,
      });
      markRetainedTerminalOutputExited(db, terminal.id, otherHost.id, 2 + (index % 7));
    }
    const sessionIds = scenario.sessions.map((session, index) => {
      const terminal = create(host.id, index);
      labels.set(terminal.id, `session:${index}`);
      for (const chunk of session.chunks) {
        appendRetainedTerminalOutputChunk(db, {
          hostId: host.id,
          terminalSessionId: terminal.id,
          chunk,
          now: session.retainedAt,
        });
      }
      if (session.expired && !session.ownedByTarget) {
        markRetainedTerminalOutputExited(db, terminal.id, host.id, 3 + (index % 5));
      }
      return terminal.id;
    });
    const before = db.$client
      .prepare("SELECT COUNT(*) AS count FROM fork_terminal_output WHERE expires_at <= ?")
      .get(replayNow) as { count: number };
    const target = sessionIds[0] ?? "";
    if (mode === "batched") {
      appendRetainedTerminalOutputChunks(db, {
        hostId: host.id,
        terminalSessionId: target,
        chunks: scenario.replay,
        now: replayNow,
      });
    } else {
      for (const chunk of scenario.replay) {
        appendRetainedTerminalOutputChunk(db, {
          hostId: host.id,
          terminalSessionId: target,
          chunk,
          now: replayNow,
        });
      }
    }
    const rows = (
      db.$client
        .prepare(
          `SELECT terminal_session_id AS terminalSessionId, host_id AS hostId, chunks_json AS chunksJson,
                  byte_length AS byteLength, retained_at AS retainedAt, expires_at AS expiresAt
           FROM fork_terminal_output`,
        )
        .all() as {
        terminalSessionId: string;
        hostId: string;
        chunksJson: string;
        byteLength: number;
        retainedAt: number;
        expiresAt: number | null;
      }[]
    )
      .map((row) => ({
        ...row,
        terminalSessionId: labels.get(row.terminalSessionId) ?? row.terminalSessionId,
        hostId: labels.get(row.hostId) ?? row.hostId,
      }))
      .sort((left, right) => left.terminalSessionId.localeCompare(right.terminalSessionId));
    return { rows, expiredBefore: before.count };
  }

  const hostLoad = (scenario: Scenario) => {
    const live = scenario.sessions.length + 1;
    const bytes = scenario.sessions.reduce(
      (total, session) =>
        total +
        Math.min(
          TERMINAL_RETAINED_OUTPUT_BYTES,
          session.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.dataBase64, "base64"), 0),
        ),
      0,
    );
    return { live, bytes };
  };

  it("matches the per-chunk path on every row for 40 seeded replays without host pressure", () => {
    let prunedBeyondOneBatch = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const scenario = buildScenario(seed, false);
      const load = hostLoad(scenario);
      expect(load.live).toBeLessThanOrEqual(HOST_RETAINED_TERMINAL_LIMIT);
      expect(load.bytes + TERMINAL_RETAINED_OUTPUT_BYTES).toBeLessThanOrEqual(HOST_RETAINED_OUTPUT_BYTES);
      const reference = runScenario(scenario, "per-chunk");
      const batched = runScenario(scenario, "batched");
      if (reference.expiredBefore > 128 && scenario.replay.length > 1) prunedBeyondOneBatch += 1;
      expect({ seed, rows: batched.rows }).toEqual({ seed, rows: reference.rows });
    }
    process.stdout.write(`seeded replays: 40 without host pressure, ${prunedBeyondOneBatch} needing more than one prune batch\n`);
    expect(prunedBeyondOneBatch).toBeGreaterThan(5);
  }, 120_000);

  it("keeps the host caps and never evicts more from other sessions than the per-chunk path, for 12 seeded replays under host pressure", () => {
    let underPressure = 0;
    for (let seed = 101; seed <= 112; seed += 1) {
      const scenario = buildScenario(seed, true);
      const reference = runScenario(scenario, "per-chunk");
      const batched = runScenario(scenario, "batched");
      const load = hostLoad(scenario);
      if (load.live > HOST_RETAINED_TERMINAL_LIMIT || load.bytes + TERMINAL_RETAINED_OUTPUT_BYTES > HOST_RETAINED_OUTPUT_BYTES) {
        underPressure += 1;
      }
      const targetRows = batched.rows.filter((row) => row.hostId === "host:target");
      expect(targetRows.length).toBeLessThanOrEqual(HOST_RETAINED_TERMINAL_LIMIT);
      expect(targetRows.reduce((total, row) => total + row.byteLength, 0)).toBeLessThanOrEqual(HOST_RETAINED_OUTPUT_BYTES);
      for (const row of batched.rows) {
        expect(row.byteLength).toBe(
          JSON.parse(row.chunksJson).reduce(
            (total: number, entry: { chunk: { dataBase64: string } }) =>
              total + Buffer.byteLength(entry.chunk.dataBase64, "base64"),
            0,
          ),
        );
      }
      const chunkCount = (rows: typeof batched.rows, label: string) => {
        const row = rows.find((candidate) => candidate.terminalSessionId === label);
        return row ? JSON.parse(row.chunksJson).length : 0;
      };
      for (const row of reference.rows) {
        if (row.terminalSessionId === "session:0") continue;
        expect({ seed, session: row.terminalSessionId, kept: chunkCount(batched.rows, row.terminalSessionId) >= chunkCount(reference.rows, row.terminalSessionId) }).toEqual({
          seed,
          session: row.terminalSessionId,
          kept: true,
        });
      }
    }
    process.stdout.write(`seeded replays: 12 generated for host pressure, ${underPressure} over a host cap\n`);
    expect(underPressure).toBeGreaterThan(6);
  }, 120_000);
});
