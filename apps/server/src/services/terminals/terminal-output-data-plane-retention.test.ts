import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRetainedTerminalOutputChunks,
  createTerminalSession,
  getRetainedTerminalOutput,
  getTerminalSession,
  listTerminalSessions,
  pruneRetainedTerminalOutput,
} from "@bb/db";
import { createDaemonSocketMessageQueue } from "../../ws/daemon-protocol.js";
import { createTerminalGridMarker } from "@bb/domain";
import { createMigratedConnection } from "@bb/db/testing";
import { takeEventLoopWorkWindowSnapshot } from "../system/event-loop-work.js";
import {
  TerminalDataPlaneChild,
  type TerminalDataPlaneSocket,
} from "../../terminal-data-plane/data-plane-child.js";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "../../terminal-data-plane/ipc-contract.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../../test/helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../../test/helpers/test-app.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;
const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

class FakeSocket implements TerminalDataPlaneSocket {
  bufferedAmount = 0;
  private messageListeners: Array<(data: unknown) => void> = [];

  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown) => void),
  ): unknown {
    if (event === "message") {
      this.messageListeners.push(listener as (data: unknown) => void);
    }
    return this;
  }

  close(): void {}

  send(): void {}

  terminate(): void {}

  receive(message: unknown): void {
    const data =
      typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }
}

function retainedAfterFlush(
  terminalSessions: { flushAllRetainedOutput(): void },
  ...args: Parameters<typeof getRetainedTerminalOutput>
): ReturnType<typeof getRetainedTerminalOutput> {
  terminalSessions.flushAllRetainedOutput();
  return getRetainedTerminalOutput(...args);
}

function outputChunks(): Array<{ seq: number; dataBase64: string }> {
  return Array.from({ length: 8 }, (_, seq) => ({
    seq,
    dataBase64: Buffer.from(`R-${seq + 1}\n`).toString("base64"),
  }));
}

function textFrom(chunks: Array<{ dataBase64: string }>): string {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
}

async function setup(args: { holdOutputBatches?: boolean } = {}) {
  const harness = await createTestAppHarness({
    db: createMigratedConnection(),
  });
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = seedThread(harness.deps, { projectId: project.id });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    environmentId: null,
    hostId: host.id,
    daemonSessionId: session.id,
    initialCwd: "/tmp",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Unwatched output",
  });
  const daemonSocket = new FakeSocket();
  const childMessages: TerminalDataPlaneChildMessage[] = [];
  const heldOutputBatches: Array<{
    message: Extract<
      TerminalDataPlaneChildMessage,
      { type: "terminal.output-batch" }
    >;
    onSent: () => void;
  }> = [];
  const child = new TerminalDataPlaneChild({
    exit: () => undefined,
    rssBytes: () => 1,
    sendToMain: (message, onSent) => {
      childMessages.push(message);
      if (message.type === "terminal.output-batch") {
        if (args.holdOutputBatches) {
          heldOutputBatches.push({ message, onSent });
          return;
        }
        harness.deps.terminalSessions.recordDirectTerminalOutputBatch(message);
      }
      onSent();
    },
    upgrade: async () => daemonSocket,
  });
  child.handleMainMessage(
    {
      v: V,
      type: "daemon.attach",
      daemonSessionId: session.id,
      request: { url: "/terminal-data", headers: [], headBase64: "" },
    },
    new Socket(),
  );
  await Promise.resolve();
  await Promise.resolve();
  const sendMain = (message: TerminalDataPlaneMainMessage) =>
    child.handleMainMessage(message, undefined);
  sendMain({
    v: V,
    type: "terminal.route",
    terminalId: terminal.id,
    daemonSessionId: session.id,
    mode: "data-socket",
  });
  return {
    child,
    childMessages,
    daemonSocket,
    db: harness.db,
    harness,
    heldOutputBatches,
    host,
    hub: harness.hub,
    sendMain,
    session,
    terminal,
    terminalSessions: harness.deps.terminalSessions,
    releaseOutputBatches() {
      for (const { message, onSent } of heldOutputBatches.splice(0)) {
        harness.deps.terminalSessions.recordDirectTerminalOutputBatch(message);
        onSent();
      }
    },
  };
}

describe("terminal output retained from the data plane", () => {
  it("bounds replay catch-up while preserving output arriving at every yield and a queued daemon message", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const queue = createDaemonSocketMessageQueue<() => void | Promise<void>>({
      handle: (message) => message(),
      onError: (error) => {
        throw error;
      },
    });
    queue.release();
    let replayFinished = false;
    let producerActive = true;
    try {
      let producerRounds = 0;
      let queuedMessageProcessed = false;
      let resolveQueuedMessage!: () => void;
      const queuedMessage = new Promise<void>((resolve) => {
        resolveQueuedMessage = resolve;
      });
      const replayChunks = Array.from({ length: 2_048 }, (_, seq) => ({
        seq,
        dataBase64: Buffer.from("r").toString("base64"),
      }));
      queue.enqueue(() =>
        Promise.resolve(
          fixture.terminalSessions.handleDaemonTerminalMessage({
            hostId: fixture.host.id,
            sessionId: fixture.session.id,
            message: {
              type: "terminal.replay",
              requestId: "bounded-concurrent-replay",
              terminalId: fixture.terminal.id,
              replayStartSeq: 0,
              nextSeq: replayChunks.length,
              chunks: replayChunks,
            },
          }),
        ).then(() => {
          replayFinished = true;
        }),
      );
      queue.enqueue(() => {
        return Promise.resolve(
          fixture.terminalSessions.handleDaemonTerminalMessage({
            hostId: fixture.host.id,
            sessionId: fixture.session.id,
            message: {
              type: "terminal.output",
              terminalId: fixture.terminal.id,
              chunk: {
                seq: 1_000_000,
                dataBase64: Buffer.from("q").toString("base64"),
              },
            },
          }),
        ).then(() => {
          queuedMessageProcessed = true;
          resolveQueuedMessage();
        });
      });

      const produceAtReplayYields = () => {
        if (!producerActive || replayFinished) return;
        producerRounds += 1;
        const firstSeq = 100_000 + (producerRounds - 1) * 257;
        fixture.terminalSessions.recordDirectTerminalOutputBatch({
          daemonSessionId: fixture.session.id,
          terminalId: fixture.terminal.id,
          chunks: Array.from({ length: 257 }, (_, offset) => ({
            seq: firstSeq + offset,
            dataBase64: Buffer.from(offset === 256 ? "x" : "").toString(
              "base64",
            ),
          })),
        });
        setImmediate(produceAtReplayYields);
      };
      setImmediate(produceAtReplayYields);

      const completedWithinBound = await Promise.race([
        queuedMessage.then(() => true),
        delay(1_000).then(() => false),
      ]);
      producerActive = false;
      if (!completedWithinBound) {
        await Promise.race([queuedMessage, delay(5_000)]);
      }

      expect(completedWithinBound).toBe(true);
      expect(queuedMessageProcessed).toBe(true);
      expect(producerRounds).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      const retainedSeqs = retained?.map(({ seq }) => seq) ?? [];
      const expectedSeqs = [
        ...replayChunks.map(({ seq }) => seq),
        ...Array.from(
          { length: producerRounds * 257 },
          (_, index) => 100_000 + index,
        ),
        1_000_000,
      ];
      expect(retainedSeqs).toEqual(expectedSeqs);
      expect(new Set(retainedSeqs).size).toBe(retainedSeqs.length);
      expect(
        retained?.filter(({ dataBase64 }) => dataBase64 === "eA==").length,
      ).toBe(producerRounds);
    } finally {
      producerActive = false;
      queue.close();
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 10_000);

  it("persists data-plane output recorded during replay on the post-replay flush", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from("before replay").toString("base64"),
          },
        ],
      });
      const chunks = Array.from({ length: 2_048 }, (_, index) => ({
        seq: index + 1,
        dataBase64: Buffer.from(`replay-${index}`).toString("base64"),
      }));
      const injectedSeqs: number[] = [];
      let replayFinished = false;
      let yields = 0;
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "data-plane-during-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length + 1,
          chunks,
        },
      });
      const recordDuringReplayYield = () => {
        yields += 1;
        if (yields >= 250) {
          const seq = 100_000 + yields;
          fixture.terminalSessions.recordDirectTerminalOutputBatch({
            daemonSessionId: fixture.session.id,
            terminalId: fixture.terminal.id,
            chunks: [
              {
                seq,
                dataBase64: Buffer.from(`arrived-${seq}`).toString("base64"),
              },
            ],
          });
          injectedSeqs.push(seq);
        }
        if (!replayFinished) setImmediate(recordDuringReplayYield);
      };
      setImmediate(recordDuringReplayYield);

      await Promise.resolve(replay).finally(() => {
        replayFinished = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(injectedSeqs.length).toBeGreaterThan(0);
      expect(retained?.map(({ seq }) => seq)).toEqual(
        expect.arrayContaining(injectedSeqs),
      );
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  });

  it("does not flush pending chunks again after a replay replaces them with its retained tail", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pendingChunks = Array.from({ length: 2 }, (_, seq) => ({
        seq,
        dataBase64: Buffer.alloc(16 * 1024, seq + 1).toString("base64"),
      }));
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: pendingChunks,
      });
      fixture.db.$client.exec(`
        CREATE TABLE replay_cleanup_writes (n INTEGER NOT NULL);
        INSERT INTO replay_cleanup_writes (n) VALUES (0);
        CREATE TRIGGER replay_cleanup_insert AFTER INSERT ON fork_terminal_output
          BEGIN UPDATE replay_cleanup_writes SET n = n + 1; END;
        CREATE TRIGGER replay_cleanup_update AFTER UPDATE ON fork_terminal_output
          BEGIN UPDATE replay_cleanup_writes SET n = n + 1; END;
      `);

      const replayChunks = Array.from({ length: 128 }, (_, index) => ({
        seq: index + pendingChunks.length,
        dataBase64: Buffer.alloc(1024, index + 3).toString("base64"),
      }));
      await fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "replay-cleans-pending-output",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: replayChunks.length + pendingChunks.length,
          chunks: replayChunks,
        },
      });

      const writesAfterReplay = (
        fixture.db.$client
          .prepare("SELECT n FROM replay_cleanup_writes")
          .get() as { n: number }
      ).n;
      const retainedAfterReplay = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      const seqsAfterReplay = retainedAfterReplay?.map(({ seq }) => seq);
      expect(
        Buffer.byteLength(replayChunks[0]!.dataBase64, "base64") *
          replayChunks.length,
      ).toBeGreaterThan(64 * 1024);
      expect(seqsAfterReplay).not.toContain(pendingChunks[0]!.seq);
      expect(seqsAfterReplay).not.toContain(pendingChunks[1]!.seq);

      await vi.advanceTimersByTimeAsync(1_000);

      const writesAfterTimer = (
        fixture.db.$client
          .prepare("SELECT n FROM replay_cleanup_writes")
          .get() as { n: number }
      ).n;
      const retainedAfterTimer = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(writesAfterTimer).toBe(writesAfterReplay);
      expect(retainedAfterTimer?.map(({ seq }) => seq)).toEqual(
        seqsAfterReplay,
      );
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 60_000);

  it("does not write retained output when replaying already-retained 1.5 MB scrollback", async () => {
    const fixture = await setup();
    const chunks = Array.from({ length: 32 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.alloc(48 * 1024, seq).toString("base64"),
    }));
    appendRetainedTerminalOutputChunks(fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      chunks,
      clock: Date.now,
    });
    fixture.db.$client.exec(`
      CREATE TABLE retained_replay_writes (n INTEGER NOT NULL);
      INSERT INTO retained_replay_writes (n) VALUES (0);
      CREATE TRIGGER retained_replay_updated AFTER UPDATE ON fork_terminal_output
        BEGIN UPDATE retained_replay_writes SET n = n + 1; END;
    `);

    takeEventLoopWorkWindowSnapshot();
    await fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "already-retained-large-replay",
        terminalId: fixture.terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });

    const writes = fixture.db.$client
      .prepare("SELECT n FROM retained_replay_writes")
      .get() as { n: number };
    expect(writes.n).toBe(0);
    const replayWork = takeEventLoopWorkWindowSnapshot();
    process.stdout.write(
      `retained replay max synchronous slice ${replayWork.longestSynchronousWorkWallMs}ms\n`,
    );
    expect(replayWork.longestSynchronousWork).toMatch(
      /^ws:daemon terminal\.replay /u,
    );
    expect(replayWork.longestSynchronousWorkWallMs).toBeLessThanOrEqual(100);
    const retained = getRetainedTerminalOutput(fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    expect(retained?.map(({ seq }) => seq)).toEqual([31]);
    expect(
      Buffer.from(chunks[0]!.dataBase64, "base64").length * chunks.length,
    ).toBe(1_572_864);
    fixture.child.shutdown();
  });

  it("keeps a 1.5 MB pending replay flush below 100 ms per synchronous slice", async () => {
    const fixture = await setup();
    const chunks = Array.from({ length: 32 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.alloc(48 * 1024, seq).toString("base64"),
    }));
    fixture.terminalSessions.recordDirectTerminalOutputBatch({
      daemonSessionId: fixture.session.id,
      terminalId: fixture.terminal.id,
      chunks,
    });

    takeEventLoopWorkWindowSnapshot();
    await fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "pending-large-replay",
        terminalId: fixture.terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });

    const replayWork = takeEventLoopWorkWindowSnapshot();
    process.stdout.write(
      `pending replay max synchronous slice ${replayWork.longestSynchronousWork} ${replayWork.longestSynchronousWorkWallMs}ms\n`,
    );
    expect(replayWork.longestSynchronousWork).toMatch(
      /^ws:daemon terminal\.replay /u,
    );
    expect(replayWork.longestSynchronousWorkWallMs).toBeLessThanOrEqual(100);
    const retained = retainedAfterFlush(fixture.terminalSessions, fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    expect(retained?.at(-1)?.seq).toBe(31);
    expect(
      Buffer.from(chunks[0]!.dataBase64, "base64").length * chunks.length,
    ).toBe(1_572_864);
    fixture.child.shutdown();
  });

  it("yields between bounded replay chunks and retains their original order", async () => {
    const fixture = await setup();
    const chunks = Array.from({ length: 1_000 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(
        Array.from(
          { length: 50 },
          (_, line) => `line-${String(seq * 50 + line).padStart(5, "0")}\n`,
        ).join(""),
      ).toString("base64"),
    }));
    takeEventLoopWorkWindowSnapshot();
    let monitoring = true;
    let yieldSteps = 0;
    const observeReplayYields = (): void => {
      if (!monitoring) return;
      yieldSteps += 1;
      setImmediate(observeReplayYields);
    };
    setImmediate(observeReplayYields);

    await fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "large-replay",
        terminalId: fixture.terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });
    monitoring = false;

    const output = retainedAfterFlush(fixture.terminalSessions, fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    const retainedBytes = Buffer.concat(
      (output ?? []).map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    );
    const expectedBytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    );
    expect(retainedBytes).toEqual(
      expectedBytes.subarray(expectedBytes.length - retainedBytes.length),
    );
    expect(retainedBytes.length).toBeGreaterThan(60_000);
    expect(yieldSteps).toBeGreaterThan(1);
    const work = takeEventLoopWorkWindowSnapshot();
    expect(work.longestSynchronousWork).toMatch(
      /^ws:daemon terminal\.replay /u,
    );
    expect(work.longestSynchronousWorkWallMs).toBeLessThanOrEqual(100);
    fixture.child.shutdown();
  }, 60_000);

  it("carries the latest trimmed grid marker to the retained replay window", async () => {
    const fixture = await setup();
    const chunks = [
      `${createTerminalGridMarker({ cols: 80, rows: 24 })}${"a".repeat(30_000)}`,
      `${createTerminalGridMarker({ cols: 51, rows: 16 })}${"b".repeat(30_000)}`,
      "c".repeat(30_000),
      "d".repeat(10_000),
    ];
    chunks.forEach((text, seq) => {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk: { seq, dataBase64: Buffer.from(text).toString("base64") },
      });
    });

    const retained = retainedAfterFlush(fixture.terminalSessions, fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    expect(retained?.[0]?.seq).toBe(1);
    const firstRetainedText = Buffer.from(
      retained?.[0]?.dataBase64 ?? "",
      "base64",
    ).toString("utf8");
    expect(
      firstRetainedText.startsWith(
        createTerminalGridMarker({ cols: 51, rows: 16 }),
      ),
    ).toBe(true);
    expect(firstRetainedText).not.toContain(
      createTerminalGridMarker({ cols: 80, rows: 24 }),
    );
    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await Promise.resolve();
    const replay = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: { limitChunks: 1 },
    });
    const replayText = textFrom(replay.chunks);
    expect(
      replayText.startsWith(createTerminalGridMarker({ cols: 51, rows: 16 })),
    ).toBe(true);
    expect(replay.chunks[0]?.seq).toBe(2);
    fixture.child.shutdown();
  });

  it("writes a burst of live output to the database in one write", async () => {
    const fixture = await setup();
    fixture.db.$client.exec(`
      CREATE TABLE retained_output_writes (n INTEGER NOT NULL);
      INSERT INTO retained_output_writes (n) VALUES (0);
      CREATE TRIGGER retained_output_inserted AFTER INSERT ON fork_terminal_output
        BEGIN UPDATE retained_output_writes SET n = n + 1; END;
      CREATE TRIGGER retained_output_updated AFTER UPDATE ON fork_terminal_output
        BEGIN UPDATE retained_output_writes SET n = n + 1; END;
    `);
    const writes = () =>
      (
        fixture.db.$client
          .prepare("SELECT n FROM retained_output_writes")
          .get() as { n: number }
      ).n;
    for (let seq = 0; seq < 200; seq += 1) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk: {
          seq,
          dataBase64: Buffer.from(`line ${seq}\n`).toString("base64"),
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      fixture.childMessages.filter(
        (message) => message.type === "terminal.output-batch",
      ).length,
    ).toBeGreaterThan(0);
    expect(writes()).toBe(0);
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(writes()).toBe(1);
    const retained = getRetainedTerminalOutput(fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    expect(retained).toHaveLength(200);
    expect(textFrom(retained ?? []).endsWith("line 199\n")).toBe(true);
  });

  it("keeps queued output when a write fails and writes it on the next flush", async () => {
    const fixture = await setup();
    fixture.db.$client.exec(`
      CREATE TRIGGER retained_output_disk_full BEFORE INSERT ON fork_terminal_output
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toBeNull();
    fixture.db.$client.exec("DROP TRIGGER retained_output_disk_full");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());
    fixture.child.shutdown();
  });

  it("keeps the newest 2 MiB queued through failed writes and then stores what an uninterrupted write would", async () => {
    const fixture = await setup();
    fixture.db.$client.exec(`
      CREATE TRIGGER retained_output_disk_full BEFORE INSERT ON fork_terminal_output
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    const chunks = Array.from({ length: 2_200 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(
        `${String(seq).padStart(6, "0")}${"x".repeat(1_017)}\n`,
      ).toString("base64"),
    }));
    for (const chunk of chunks) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    fixture.terminalSessions.flushAllRetainedOutput();
    fixture.terminalSessions.flushAllRetainedOutput();
    fixture.db.$client.exec("DROP TRIGGER retained_output_disk_full");
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(chunks.slice(-64));
    fixture.child.shutdown();
  });

  it("retries failed writes at shutdown so queued output is stored before the database closes", async () => {
    const fixture = await setup();
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const client = fixture.db.$client;
    const transaction = client.transaction.bind(client);
    let failures = 2;
    vi.spyOn(client, "transaction").mockImplementation(((
      run: Parameters<typeof transaction>[0],
    ) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("disk full");
      }
      return transaction(run);
    }) as typeof client.transaction);
    fixture.terminalSessions.flushRetainedOutputBeforeClose();
    vi.restoreAllMocks();
    expect(failures).toBe(0);
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());
    fixture.child.shutdown();
  });

  it("discards output queued across failed writes only after three failed shutdown writes, leaving nothing queued", async () => {
    const fixture = await setup();
    fixture.db.$client.exec(`
      CREATE TRIGGER retained_output_disk_full BEFORE INSERT ON fork_terminal_output
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    const [first, ...rest] = outputChunks();
    if (first === undefined) throw new Error("missing chunk");
    fixture.daemonSocket.receive({
      type: "terminal.output",
      terminalId: fixture.terminal.id,
      chunk: first,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.terminalSessions.flushAllRetainedOutput();
    for (const chunk of rest) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.terminalSessions.flushAllRetainedOutput();
    const client = fixture.db.$client;
    const transaction = client.transaction.bind(client);
    let shutdownAttempts = 0;
    vi.spyOn(client, "transaction").mockImplementation(((
      run: Parameters<typeof transaction>[0],
    ) => {
      shutdownAttempts += 1;
      return transaction(run);
    }) as typeof client.transaction);
    expect(() =>
      fixture.terminalSessions.flushRetainedOutputBeforeClose(),
    ).not.toThrow();
    vi.restoreAllMocks();
    expect(shutdownAttempts).toBe(3);
    fixture.db.$client.exec("DROP TRIGGER retained_output_disk_full");
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toBeNull();
    fixture.child.shutdown();
  });

  it("keeps output queued for a terminal's new host through a failed write", async () => {
    const fixture = await setup();
    const [first, ...rest] = outputChunks();
    if (first === undefined) throw new Error("missing chunk");
    fixture.daemonSocket.receive({
      type: "terminal.output",
      terminalId: fixture.terminal.id,
      chunk: first,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = seedHostSession(fixture.harness.deps, { id: "host-other" });
    fixture.db.$client
      .prepare("UPDATE terminal_sessions SET host_id = ? WHERE id = ?")
      .run(other.host.id, fixture.terminal.id);
    for (const chunk of rest) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.db.$client.exec(`
      CREATE TRIGGER retained_output_disk_full BEFORE INSERT ON fork_terminal_output
        BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    fixture.terminalSessions.flushAllRetainedOutput();
    fixture.db.$client.exec("DROP TRIGGER retained_output_disk_full");
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: other.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(rest);
    fixture.child.shutdown();
  });

  it("does not let the prune sweep drop output that is still queued", async () => {
    const fixture = await setup();
    const [first, ...rest] = outputChunks();
    if (first === undefined) throw new Error("missing chunk");
    fixture.daemonSocket.receive({
      type: "terminal.output",
      terminalId: fixture.terminal.id,
      chunk: first,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.terminalSessions.flushAllRetainedOutput();
    for (const chunk of rest) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      pruneRetainedTerminalOutput(fixture.db, Date.now() + 365 * 86_400_000),
    ).toBe(0);
    fixture.terminalSessions.flushAllRetainedOutput();
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());
    fixture.child.shutdown();
  });

  it("lists an exited terminal with all of its queued output without a separate flush", async () => {
    const fixture = await setup();
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    expect(
      listTerminalSessions(fixture.db, {
        scope: { kind: "all" },
        visible: true,
      }).map((session) => session.id),
    ).toContain(fixture.terminal.id);
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());
    fixture.child.shutdown();
  });

  it("persists live output within about a second without a reader", async () => {
    const fixture = await setup();
    fixture.daemonSocket.receive({
      type: "terminal.output",
      terminalId: fixture.terminal.id,
      chunk: { seq: 0, dataBase64: Buffer.from("kept\n").toString("base64") },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual([
      { seq: 0, dataBase64: Buffer.from("kept\n").toString("base64") },
    ]);
  });

  it("persists live data-socket output without a browser and reads it after exit", async () => {
    const fixture = await setup();
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    fixture.sendMain({
      v: V,
      type: "terminal.unroute",
      terminalId: fixture.terminal.id,
    });

    expect(
      fixture.childMessages.filter(
        (message) => message.type === "terminal.output-batch",
      ),
    ).toHaveLength(1);
    expect(
      retainedAfterFlush(fixture.terminalSessions, fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());

    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const output = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    const lastLines = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: { lines: 3 },
    });
    expect(textFrom(output.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );
    expect(textFrom(lastLines.chunks)).toBe("R-6\nR-7\nR-8\n");
    fixture.child.shutdown();
  });

  it("replays the daemon's final chunk before marking a direct-output terminal exited", async () => {
    const fixture = await setup();
    fixture.terminalSessions.setDaemonSessionDirectOutput({
      daemonSessionId: fixture.session.id,
      enabled: true,
    });
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    fixture.hub.registerDaemon(fixture.session.id, fixture.host.id, {
      close() {},
      send(data: string) {
        const message = JSON.parse(data) as {
          requestId: string;
          terminalId: string;
          type: string;
        };
        if (message.type !== "terminal.attach") {
          return;
        }
        fixture.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId: fixture.terminal.id,
            replayStartSeq: 0,
            nextSeq: 8,
            chunks: outputChunks(),
          },
        });
      },
    });

    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.sendMain({
      v: V,
      type: "terminal.unroute",
      terminalId: fixture.terminal.id,
    });

    const output = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    expect(textFrom(output.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );
    fixture.child.shutdown();
    fixture.hub.unregisterDaemon(fixture.session.id);
  });

  it("retains only the matching held batch released after exit", async () => {
    const fixture = await setup({ holdOutputBatches: true });
    fixture.terminalSessions.setDaemonSessionDirectOutput({
      daemonSessionId: fixture.session.id,
      enabled: true,
    });
    const { session: otherSession } = seedHostSession(fixture.harness.deps);
    fixture.terminalSessions.setDaemonSessionDirectOutput({
      daemonSessionId: otherSession.id,
      enabled: true,
    });
    fixture.hub.registerDaemon(fixture.session.id, fixture.host.id, {
      close() {},
      send(data: string) {
        const message = JSON.parse(data) as {
          requestId: string;
          terminalId: string;
          type: string;
        };
        if (message.type !== "terminal.attach") {
          return;
        }
        fixture.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId: fixture.terminal.id,
            replayStartSeq: 0,
            nextSeq: 0,
            chunks: [],
          },
        });
      },
    });

    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    fixture.sendMain({
      v: V,
      type: "terminal.unroute",
      terminalId: fixture.terminal.id,
    });

    expect(fixture.heldOutputBatches).toHaveLength(1);
    expect(fixture.heldOutputBatches[0]?.message.chunks).toEqual(
      outputChunks(),
    );

    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await vi.waitFor(() => {
      expect(
        getTerminalSession(fixture.db, {
          kind: "terminal",
          terminalId: fixture.terminal.id,
        })?.status,
      ).toBe("exited");
    });
    expect(
      getTerminalSession(fixture.db, {
        kind: "terminal",
        terminalId: fixture.terminal.id,
      })?.daemonSessionId,
    ).toBe(fixture.session.id);
    expect(
      retainedAfterFlush(fixture.terminalSessions, fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toBeNull();

    fixture.releaseOutputBatches();
    expect(
      retainedAfterFlush(fixture.terminalSessions, fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).not.toBeNull();

    const output = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    expect(textFrom(output.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );

    fixture.terminalSessions.recordDirectTerminalOutputBatch({
      daemonSessionId: otherSession.id,
      terminalId: fixture.terminal.id,
      chunks: Array.from({ length: 8 }, (_, index) => ({
        seq: index + 8,
        dataBase64: Buffer.from(`B-${index + 1}\n`).toString("base64"),
      })),
    });
    expect(
      retainedAfterFlush(fixture.terminalSessions, fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());
    const outputAfterOtherSession =
      await fixture.terminalSessions.readTerminalOutput({
        terminalId: fixture.terminal.id,
        query: {},
      });
    expect(textFrom(outputAfterOtherSession.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );
    fixture.child.shutdown();
    fixture.hub.unregisterDaemon(fixture.session.id);
  });
});
