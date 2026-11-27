import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectBridgeSocket,
  createShortSocketDir,
} from "../testing/bridge-socket-client.js";
import {
  BRIDGE_OPEN_WORK_METHOD,
  type BridgeSocketServer,
  type BridgeSocketShutdownReason,
  createBridgeSocketServer,
  parseBridgeOpenWorkMessage,
} from "./bridge-socket-server.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface StartServerOptions {
  reattachTtlMs?: number;
  memoryCapBytes?: number;
  hardCapBytes?: number;
}

async function startServer(options: StartServerOptions = {}): Promise<{
  server: BridgeSocketServer;
  socketPath: string;
  spillPath: string;
  received: string[];
  shutdowns: BridgeSocketShutdownReason[];
  backpressure: boolean[];
  lifecycle: string[];
}> {
  const dir = await createShortSocketDir();
  const socketPath = join(dir, "w.sock");
  const spillPath = join(dir, "w.buf");
  const received: string[] = [];
  const shutdowns: BridgeSocketShutdownReason[] = [];
  const backpressure: boolean[] = [];
  const lifecycle: string[] = [];
  const server = createBridgeSocketServer({
    socketPath,
    spillPath,
    reattachTtlMs: options.reattachTtlMs ?? 60_000,
    memoryCapBytes: options.memoryCapBytes ?? 1024 * 1024,
    hardCapBytes: options.hardCapBytes ?? 16 * 1024 * 1024,
    onOverflow: () => undefined,
    onBackpressure: (paused, retainedBytes) => {
      backpressure.push(paused);
      lifecycle.push(`${paused ? "pause" : "resume"}:${retainedBytes > 0}`);
    },
  });
  cleanups.push(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await server.listen({
    onLine: (line) => received.push(line),
    onShutdown: (reason) => {
      shutdowns.push(reason);
      lifecycle.push(`shutdown:${reason}`);
    },
  });
  return {
    server,
    socketPath,
    spillPath,
    received,
    shutdowns,
    backpressure,
    lifecycle,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function payload(n: number, padding = 0): string {
  return JSON.stringify({ n, pad: "x".repeat(padding) });
}

describe("createBridgeSocketServer", () => {
  it("numbers every output line and holds it until a runtime resumes past it", async () => {
    const { server, socketPath } = await startServer();
    server.write(`${payload(1)}\n${payload(2)}`);
    server.write(`\n${payload(3)}\n`);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(3));

    expect(client.frames.map((frame) => frame.wseq)).toEqual([1, 2, 3]);
    expect(client.lines).toEqual([payload(1), payload(2), payload(3)]);
    client.socket.destroy();
  });

  it("replays exactly the unacknowledged lines to the next runtime, with no gaps", async () => {
    const { server, socketPath } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 5; n += 1) server.write(`${payload(n)}\n`);
    await first.waitForLine((line) => line === payload(5));
    first.ack(3);
    await wait(20);
    first.socket.destroy();
    await first.closed;
    for (let n = 6; n <= 8; n += 1) server.write(`${payload(n)}\n`);

    const second = await connectBridgeSocket(socketPath, { resumeAfter: 3 });
    await second.waitForLine((line) => line === payload(8));

    expect(second.frames.map((frame) => frame.wseq)).toEqual([4, 5, 6, 7, 8]);
    second.socket.destroy();
  });

  it("drops acknowledged lines but keeps the ones the runtime asked it to keep, and replays only those", async () => {
    const { server, socketPath } = await startServer({
      memoryCapBytes: 200,
      hardCapBytes: 16 * 1024 * 1024,
    });
    const first = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 6; n += 1) server.write(`${payload(n, 40)}\n`);
    await first.waitForLine((line) => line === payload(6, 40));
    first.send({ method: "bridge/ack", params: { through: 6, keep: [2, 5] } });
    await wait(20);
    expect(server.replayStats().frames).toBe(2);
    first.socket.destroy();
    await first.closed;

    const second = await connectBridgeSocket(socketPath, { resumeAfter: 0 });
    await second.waitForLine((line) => line === payload(5, 40));
    expect(second.frames.map((frame) => frame.wseq)).toEqual([2, 5]);
    second.send({ method: "bridge/ack", params: { through: 6, keep: [] } });
    await wait(20);
    expect(server.replayStats()).toEqual({
      frames: 0,
      memoryBytes: 0,
      spilledBytes: 0,
    });
    second.socket.destroy();
  });

  it("stops spilling once memory has room again, even while a kept frame sits on disk", async () => {
    const memoryCapBytes = 8 * 1024;
    const { server, socketPath, spillPath } = await startServer({
      memoryCapBytes,
      hardCapBytes: 64 * 1024 * 1024,
    });
    for (let n = 1; n <= 20; n += 1) {
      server.write(`${payload(n, 1_000)}\n`);
    }
    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(20, 1_000));
    client.ack(20, [20]);
    await wait(50);
    const spilledWithKeptFrame = server.replayStats().spilledBytes;
    expect(spilledWithKeptFrame).toBeGreaterThan(0);
    const spillSizeWithKeptFrame = statSync(spillPath).size;

    let wseq = 20;
    for (let batch = 0; batch < 100; batch += 1) {
      for (let line = 0; line < 100; line += 1) {
        wseq += 1;
        server.write(`${payload(wseq, 8)}\n`);
      }
      client.ack(wseq, [20]);
      await wait(2);
    }

    expect(statSync(spillPath).size).toBe(spillSizeWithKeptFrame);
    expect(server.replayStats().spilledBytes).toBe(spilledWithKeptFrame);
    client.socket.destroy();
  }, 20_000);

  it("keeps a long detached period within its memory cap by spilling to disk", async () => {
    const memoryCapBytes = 64 * 1024;
    const { server, socketPath, spillPath } = await startServer({
      memoryCapBytes,
      hardCapBytes: 64 * 1024 * 1024,
    });
    const lineCount = 2_000;
    for (let n = 1; n <= lineCount; n += 1) {
      server.write(`${payload(n, 1_000)}\n`);
    }

    const stats = server.replayStats();
    expect(stats.memoryBytes).toBeLessThanOrEqual(memoryCapBytes);
    expect(stats.frames).toBe(lineCount);
    expect(stats.spilledBytes).toBeGreaterThan(1_900_000);
    expect(statSync(spillPath).size).toBe(stats.spilledBytes);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(lineCount, 1_000));
    expect(client.frames.map((frame) => frame.wseq)).toEqual(
      Array.from({ length: lineCount }, (_, index) => index + 1),
    );
    client.ack(lineCount);
    await wait(50);
    expect(server.replayStats()).toEqual({
      frames: 0,
      memoryBytes: 0,
      spilledBytes: 0,
    });
    expect(existsSync(spillPath)).toBe(false);
    client.socket.destroy();
  });

  it("pauses the provider at the hard cap instead of dropping output, and resumes once acknowledged", async () => {
    const { server, socketPath, backpressure } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
    });
    const client = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);

    expect(backpressure).toEqual([true]);
    expect(server.replayStats().frames).toBe(200);

    await client.waitForLine((line) => line === payload(200, 1_000));
    client.ack(200);
    await wait(50);
    expect(backpressure).toEqual([true, false]);
    client.socket.destroy();
  });

  it("never holds a detached worker paused, so the reattach window can still retire it", async () => {
    const { server, socketPath, backpressure, lifecycle } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
      reattachTtlMs: 150,
    });
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);
    expect(backpressure).toEqual([]);

    const client = await connectBridgeSocket(socketPath);
    await client.waitForLine((line) => line === payload(200, 1_000));
    expect(backpressure).toEqual([true]);
    client.socket.destroy();
    await client.closed;
    await wait(20);
    expect(backpressure).toEqual([true, false]);

    for (let n = 201; n <= 400; n += 1) server.write(`${payload(n, 1_000)}\n`);
    await wait(250);
    expect(lifecycle).toEqual([
      "pause:true",
      "resume:true",
      "shutdown:abandoned",
    ]);
  });

  it("continues a paused provider before it acts on bridge/shutdown", async () => {
    const { server, socketPath, lifecycle } = await startServer({
      memoryCapBytes: 16 * 1024,
      hardCapBytes: 128 * 1024,
    });
    const client = await connectBridgeSocket(socketPath);
    for (let n = 1; n <= 200; n += 1) server.write(`${payload(n, 1_000)}\n`);
    expect(lifecycle).toEqual(["pause:true"]);

    client.send({ method: "bridge/shutdown" });
    await client.closed;
    expect(lifecycle).toEqual([
      "pause:true",
      "resume:true",
      "shutdown:requested",
    ]);
  });

  it("lets the newest connection replace the previous one", async () => {
    const { server, socketPath, received } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    const second = await connectBridgeSocket(socketPath);
    await first.closed;

    second.send({ method: "ping" });
    server.write('{"to":"second"}\n');
    await second.waitForLine((line) => line === '{"to":"second"}');
    await wait(20);
    expect(received).toEqual(['{"jsonrpc":"2.0","method":"ping"}']);
    second.socket.destroy();
  });

  it("shuts down when no runtime reattaches within the reattach window", async () => {
    const { socketPath, shutdowns } = await startServer({ reattachTtlMs: 150 });
    const client = await connectBridgeSocket(socketPath);
    client.socket.destroy();
    await client.closed;

    await wait(60);
    expect(shutdowns).toEqual([]);
    await wait(250);
    expect(shutdowns).toEqual(["abandoned"]);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("keeps running when a runtime reattaches inside the window", async () => {
    const { socketPath, shutdowns } = await startServer({ reattachTtlMs: 200 });
    const first = await connectBridgeSocket(socketPath);
    first.socket.destroy();
    await first.closed;
    await wait(80);
    const second = await connectBridgeSocket(socketPath);

    await wait(300);
    expect(shutdowns).toEqual([]);
    second.socket.destroy();
  });

  it("shuts down on an explicit bridge/shutdown instead of passing it to the bridge", async () => {
    const { socketPath, received, shutdowns } = await startServer();
    const client = await connectBridgeSocket(socketPath);
    client.send({ method: "bridge/shutdown" });
    await client.closed;

    expect(shutdowns).toEqual(["requested"]);
    expect(received).toEqual([]);
  });

  it("reports currently open background tasks and background delegations on bridge/resume when reportOpenWork is requested", async () => {
    const { server, socketPath, received } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    server.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: "t1",
          deltas: [
            {
              kind: "item.open",
              key: { providerItemId: "cmd-1" },
              item: { type: "command", command: "echo hi", cwd: "/tmp" },
            },
            {
              kind: "item.open",
              key: { providerItemId: "del-fg" },
              item: {
                type: "delegation",
                childRef: "child-fg",
                label: "foreground subagent",
                background: false,
              },
            },
            {
              kind: "item.open",
              key: { providerItemId: "bg-1" },
              item: {
                type: "backgroundTask",
                familyId: "fam-1",
                taskType: "bash",
                description: "long server",
                status: "pending",
                taskStatus: "running",
                skipTranscript: false,
              },
            },
            {
              kind: "item.open",
              key: { providerItemId: "bg-2" },
              item: {
                type: "backgroundTask",
                familyId: "fam-2",
                taskType: "bash",
                description: "short task",
                status: "pending",
                taskStatus: "running",
                skipTranscript: false,
              },
            },
            {
              kind: "item.open",
              key: { providerItemId: "del-bg" },
              item: {
                type: "delegation",
                childRef: "child-bg",
                label: "background subagent",
                background: true,
              },
            },
          ],
        },
      })}\n`,
    );
    await first.waitForLine((line) => line.includes('"del-bg"'));
    first.ack(first.lastWseq());
    await wait(20);
    first.socket.destroy();
    await first.closed;

    server.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: {
          threadId: "t1",
          deltas: [
            {
              kind: "item.close",
              key: { providerItemId: "bg-2" },
              status: "completed",
              item: {
                type: "backgroundTask",
                familyId: "fam-2",
                taskType: "bash",
                description: "short task",
                status: "completed",
                taskStatus: "completed",
                skipTranscript: false,
              },
            },
          ],
        },
      })}\n`,
    );

    const second = await connectBridgeSocket(socketPath, {
      resumeAfter: 1,
      reportOpenWork: true,
    });
    const openWorkLine = await second.waitForLine((line) =>
      line.includes(BRIDGE_OPEN_WORK_METHOD),
    );
    expect(parseBridgeOpenWorkMessage(openWorkLine)).toEqual({
      threads: {
        t1: [
          {
            key: { providerItemId: "bg-1" },
            item: {
              type: "backgroundTask",
              familyId: "fam-1",
              taskType: "bash",
              description: "long server",
              status: "pending",
              taskStatus: "running",
              skipTranscript: false,
            },
          },
          {
            key: { providerItemId: "del-bg" },
            item: {
              type: "delegation",
              childRef: "child-bg",
              label: "background subagent",
              background: true,
            },
          },
        ],
      },
    });
    expect(second.frames.map((frame) => frame.wseq)).toEqual([2]);

    second.send({
      id: 99,
      method: "thread/stop",
      params: { threadId: "t1", providerThreadId: "pt1", intent: "release" },
    });
    await wait(20);
    const stopDelivered = JSON.parse(received.at(-1) ?? "{}") as {
      id: string | number;
    };
    server.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: stopDelivered.id, result: {} })}\n`,
    );
    await second.waitForLine((line) => line.includes('"id":99'));
    second.ack(second.lastWseq());
    await wait(20);
    second.socket.destroy();
    await second.closed;

    const third = await connectBridgeSocket(socketPath, {
      resumeAfter: 3,
      reportOpenWork: true,
    });
    const clearedLine = await third.waitForLine((line) =>
      line.includes(BRIDGE_OPEN_WORK_METHOD),
    );
    expect(parseBridgeOpenWorkMessage(clearedLine)).toEqual({ threads: {} });
    third.socket.destroy();
  });

  it("keeps open work reported across reattach when an unanswered thread/stop or thread/discard ID is reused by another request", async () => {
    const { server, socketPath, received } = await startServer();
    const first = await connectBridgeSocket(socketPath);
    for (const [threadId, providerItemId] of [
      ["t1", "bg-1"],
      ["t2", "bg-2"],
    ] as const) {
      server.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/delta",
          params: {
            threadId,
            deltas: [
              {
                kind: "item.open",
                key: { providerItemId },
                item: {
                  type: "backgroundTask",
                  familyId: `fam-${threadId}`,
                  taskType: "bash",
                  description: "long server",
                  status: "pending",
                  taskStatus: "running",
                  skipTranscript: false,
                },
              },
            ],
          },
        })}\n`,
      );
    }
    await first.waitForLine((line) => line.includes('"bg-2"'));
    first.ack(first.lastWseq());

    first.send({
      id: 1,
      method: "thread/stop",
      params: { threadId: "t1", providerThreadId: "pt1", intent: "release" },
    });
    first.send({
      id: 2,
      method: "thread/discard",
      params: { threadId: "t2", providerThreadId: "pt2" },
    });
    await wait(20);
    expect(received).toHaveLength(2);
    const pendingStop = JSON.parse(received[0] ?? "{}") as {
      id: string | number;
    };
    const pendingDiscard = JSON.parse(received[1] ?? "{}") as {
      id: string | number;
    };
    first.socket.destroy();
    await first.closed;

    const second = await connectBridgeSocket(socketPath, {
      resumeAfter: 2,
      reportOpenWork: true,
    });
    await second.waitForLine((line) => line.includes(BRIDGE_OPEN_WORK_METHOD));
    second.send({ id: 1, method: "model/list", params: {} });
    second.send({ id: 2, method: "skills/configure", params: { roots: [] } });
    await wait(20);
    expect(received).toHaveLength(4);
    const modelListDelivered = JSON.parse(received[2] ?? "{}") as {
      id: string | number;
    };
    const skillsDelivered = JSON.parse(received[3] ?? "{}") as {
      id: string | number;
    };
    server.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: modelListDelivered.id, result: { models: [] } })}\n`,
    );
    server.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: skillsDelivered.id, result: {} })}\n`,
    );
    await second.waitForLine((line) => line.includes('"id":2'));
    second.ack(second.lastWseq());
    await wait(20);
    second.socket.destroy();
    await second.closed;

    const third = await connectBridgeSocket(socketPath, {
      resumeAfter: 4,
      reportOpenWork: true,
    });
    const stillOpenLine = await third.waitForLine((line) =>
      line.includes(BRIDGE_OPEN_WORK_METHOD),
    );
    const stillOpen = parseBridgeOpenWorkMessage(stillOpenLine);
    expect(Object.keys(stillOpen?.threads ?? {}).sort()).toEqual(["t1", "t2"]);

    server.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: pendingStop.id, result: {} })}\n`,
    );
    server.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: pendingDiscard.id, result: {} })}\n`,
    );
    await third.waitForLine((line) => line.includes('"id":2'));
    third.ack(third.lastWseq());
    await wait(20);
    third.socket.destroy();
    await third.closed;

    const fourth = await connectBridgeSocket(socketPath, {
      resumeAfter: 6,
      reportOpenWork: true,
    });
    const clearedLine = await fourth.waitForLine((line) =>
      line.includes(BRIDGE_OPEN_WORK_METHOD),
    );
    expect(parseBridgeOpenWorkMessage(clearedLine)).toEqual({ threads: {} });
    fourth.socket.destroy();
  });

  it("preserves caller ID correlation and clears open work across more than 4096 unanswered thread/stop and thread/discard requests", async () => {
    const totalReleases = 4105;
    const { server, socketPath, received } = await startServer();
    const first = await connectBridgeSocket(socketPath);

    for (const i of [1, 2, totalReleases]) {
      const threadId = `t-${i}`;
      server.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "thread/delta",
          params: {
            threadId,
            deltas: [
              {
                kind: "item.open",
                key: { providerItemId: `bg-${i}` },
                item: {
                  type: "backgroundTask",
                  familyId: `fam-${i}`,
                  taskType: "bash",
                  description: "server",
                  status: "pending",
                  taskStatus: "running",
                  skipTranscript: false,
                },
              },
            ],
          },
        })}\n`,
      );
    }
    await first.waitForLine((line) => line.includes(`"bg-${totalReleases}"`));
    first.ack(first.lastWseq());

    for (let i = 1; i <= totalReleases; i += 1) {
      const threadId = `t-${i}`;
      first.send(
        i % 2 === 1
          ? {
              id: `caller-${i}`,
              method: "thread/stop",
              params: {
                threadId,
                providerThreadId: `pt-${i}`,
                intent: "release",
              },
            }
          : {
              id: i,
              method: "thread/discard",
              params: { threadId, providerThreadId: `pt-${i}` },
            },
      );
    }

    const waitDeadline = Date.now() + 5_000;
    while (received.length < totalReleases && Date.now() < waitDeadline) {
      await wait(10);
    }
    expect(received).toHaveLength(totalReleases);

    const frameStartIdx = first.frames.length;
    const responseBatch: string[] = [];
    for (let i = 0; i < totalReleases; i += 1) {
      const delivered = JSON.parse(received[i] ?? "{}") as {
        id: string | number;
      };
      responseBatch.push(
        JSON.stringify({ jsonrpc: "2.0", id: delivered.id, result: {} }),
      );
    }
    server.write(`${responseBatch.join("\n")}\n`);

    await first.waitForLine((line) => line.includes(`"id":${totalReleases}`) || line.includes(`"id":"caller-${totalReleases}"`));
    const responseFrames = first.frames.slice(frameStartIdx);
    expect(responseFrames).toHaveLength(totalReleases);
    const restoredIds = responseFrames.map(
      (frame) => (JSON.parse(frame.line) as { id: string | number }).id,
    );
    const expectedIds = Array.from({ length: totalReleases }, (_, idx) => {
      const i = idx + 1;
      return i % 2 === 1 ? `caller-${i}` : i;
    });
    expect(restoredIds).toEqual(expectedIds);

    first.ack(first.lastWseq());
    await wait(20);
    first.socket.destroy();
    await first.closed;

    const second = await connectBridgeSocket(socketPath, {
      resumeAfter: first.lastWseq(),
      reportOpenWork: true,
    });
    const clearedLine = await second.waitForLine((line) =>
      line.includes(BRIDGE_OPEN_WORK_METHOD),
    );
    expect(parseBridgeOpenWorkMessage(clearedLine)).toEqual({ threads: {} });
    second.socket.destroy();
  });
});
