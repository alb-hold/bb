import { Socket } from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRetainedTerminalOutputChunks,
  createTerminalSession,
  getRetainedTerminalOutput,
  getTerminalSession,
  listTerminalSessions,
  pruneRetainedTerminalOutput,
  TERMINAL_RETAINED_OUTPUT_BYTES,
  updateTerminalSession,
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
  seedEnvironment,
  seedSession,
  seedProjectWithSource,
  seedThread,
} from "../../../test/helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../../test/helpers/test-app.js";
import {
  shutdownServerRuntime,
  startHttpListener,
} from "../../start-server.js";

const replayYieldControl = vi.hoisted(() => ({
  intercept: null as (() => Promise<void>) | null,
}));

vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...timers,
    setImmediate: (...args: Parameters<typeof timers.setImmediate>) => {
      const intercept = replayYieldControl.intercept;
      return intercept ? intercept() : timers.setImmediate(...args);
    },
  };
});

const V = TERMINAL_DATA_PLANE_IPC_VERSION;
const harnesses: TestAppHarness[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

class FakeSocket implements TerminalDataPlaneSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
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

  send(data?: string): void {
    if (data !== undefined) this.sent.push(data);
  }

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

function replayChunks(
  count = 1_024,
): Array<{ seq: number; dataBase64: string }> {
  const dataBase64 = Buffer.alloc(1_024, "r").toString("base64");
  return Array.from({ length: count }, (_, seq) => ({ seq, dataBase64 }));
}

function textFrom(chunks: Array<{ dataBase64: string }>): string {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
}

async function setup(
  args: {
    holdOutputBatches?: boolean;
    terminalStatus?: "running" | "starting";
    environmentBacked?: boolean;
    threadless?: boolean;
  } = {},
) {
  const harness = await createTestAppHarness({
    db: createMigratedConnection(),
  });
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = args.environmentBacked
    ? seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id })
    : null;
  const thread = seedThread(harness.deps, { projectId: project.id });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    environmentId: environment?.id ?? null,
    hostId: host.id,
    daemonSessionId: session.id,
    initialCwd: "/tmp",
    rows: 24,
    status: args.terminalStatus ?? "running",
    threadId: args.threadless ? null : thread.id,
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
    environment,
    harness,
    heldOutputBatches,
    host,
    hub: harness.hub,
    sendMain,
    session,
    thread,
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

function seedMaintainedScreen(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.terminalSessions.recordDirectTerminalOutputBatch({
    daemonSessionId: fixture.session.id,
    terminalId: fixture.terminal.id,
    chunks: [
      {
        seq: 0,
        dataBase64: Buffer.from("cached screen").toString("base64"),
      },
    ],
  });
  return Reflect.get(fixture.terminalSessions, "terminalScreenStates");
}

async function retainReplayAcrossLifecycleTransition(args: {
  setup: {
    terminalStatus?: "running" | "starting";
    environmentBacked?: boolean;
  };
  transition: (fixture: Awaited<ReturnType<typeof setup>>) => void;
  expectedStatus: "disconnected" | "exited";
}) {
  const fixture = await setup(args.setup);
  const chunks = Array.from({ length: 1_024 }, (_, seq) => ({
    seq: seq + 10,
    dataBase64: Buffer.from(
      `replay-${seq.toString().padStart(4, "0")}\n`,
    ).toString("base64"),
  }));
  const pending = Array.from({ length: 3 }, (_, seq) => ({
    seq,
    dataBase64: Buffer.from(`pending-${seq}\n`).toString("base64"),
  }));
  const duringReplay = {
    seq: 2_000,
    dataBase64: Buffer.from("output-during-replay\n").toString("base64"),
  };
  const initialPending =
    args.setup.terminalStatus === "starting" ? [] : pending;
  const outputDuringReplay =
    args.setup.terminalStatus === "starting" ? [] : [duringReplay];
  const queue = createDaemonSocketMessageQueue<() => void | Promise<void>>({
    handle: (message) => message(),
    onError: (error) => {
      throw error;
    },
  });
  let replay: Promise<void> | undefined;
  let replaySettled = false;
  let queueProgressed = false;
  let resolveQueueProgress!: () => void;
  const queueProgress = new Promise<void>((resolve) => {
    resolveQueueProgress = resolve;
  });
  fixture.terminalSessions.recordDirectTerminalOutputBatch({
    daemonSessionId: fixture.session.id,
    terminalId: fixture.terminal.id,
    chunks: initialPending,
  });
  queue.enqueue(() => {
    replay = Promise.resolve(
      fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "lifecycle-transition-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: 10,
          nextSeq: chunks.at(-1)!.seq + 1,
          chunks,
        },
      }),
    ).finally(() => {
      replaySettled = true;
    });
    return replay;
  });
  queue.enqueue(() => {
    queueProgressed = true;
    resolveQueueProgress();
  });
  queue.release();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replaySettled).toBe(false);
    expect(queueProgressed).toBe(false);
    if (outputDuringReplay.length > 0) {
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: outputDuringReplay,
      });
    }
    args.transition(fixture);
    await Promise.race([
      queueProgress,
      delay(5_000).then(() => {
        throw new Error("serialized daemon queue did not progress");
      }),
    ]);
    await Promise.race([
      replay,
      delay(5_000).then(() => {
        throw new Error("terminal replay caller did not settle");
      }),
    ]);
    expect(replaySettled).toBe(true);
    expect(queueProgressed).toBe(true);
    const retained = getRetainedTerminalOutput(fixture.db, {
      hostId: fixture.host.id,
      terminalSessionId: fixture.terminal.id,
      now: Date.now(),
    });
    expect(retained).toEqual([
      ...initialPending,
      ...chunks,
      ...outputDuringReplay,
    ]);
    expect(new Set(retained?.map(({ seq }) => seq)).size).toBe(
      retained?.length,
    );
    const terminal = getTerminalSession(fixture.db, {
      kind: "terminal",
      terminalId: fixture.terminal.id,
    });
    expect(terminal?.status).toBe(args.expectedStatus);
    expect(terminal?.daemonSessionId).toBeNull();
    if (args.expectedStatus === "exited") {
      const row = fixture.db.$client
        .prepare(
          "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(fixture.terminal.id) as { expiresAt: number | null } | undefined;
      expect(row?.expiresAt).toBeGreaterThan(Date.now());
    }
  } finally {
    queue.close();
    fixture.child.shutdown();
  }
}

describe("terminal output retained from the data plane", () => {
  it("flushes output and waits for replay before shutdown without logging it as lost", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errorLog = vi.spyOn(fixture.harness.deps.logger, "error");
    let replaySettled = false;
    const chunks = replayChunks();
    try {
      const replay = Promise.resolve(
        fixture.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: "shutdown-during-replay",
            terminalId: fixture.terminal.id,
            replayStartSeq: 0,
            nextSeq: chunks.length,
            chunks,
          },
        }),
      ).finally(() => {
        replaySettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(replaySettled).toBe(false);
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [
          {
            seq: 5_000,
            dataBase64: Buffer.from("during shutdown").toString("base64"),
          },
        ],
      });

      await fixture.terminalSessions.flushRetainedOutputBeforeClose();
      expect(replaySettled).toBe(true);
      await replay;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        getRetainedTerminalOutput(fixture.db, {
          hostId: fixture.host.id,
          terminalSessionId: fixture.terminal.id,
          now: Date.now(),
        })?.map(({ seq }) => seq),
      ).toContain(5_000);
      expect(
        errorLog.mock.calls.some(([, message]) =>
          String(message).includes("Lost retained terminal output at shutdown"),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 15_000);

  it("stops a marker replay before the database closes during bounded shutdown", async () => {
    const fixture = await setup();
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    const send = vi
      .spyOn(fixture.hub, "sendDaemonSessionMessage")
      .mockImplementation((sessionId, message) => {
        if (message.type === "terminal.open") {
          fixture.terminalSessions.handleDaemonTerminalMessage({
            hostId: fixture.host.id,
            sessionId,
            message: {
              type: "terminal.opened",
              requestId: message.requestId,
              terminalId: message.terminalId,
              shell: "/bin/sh",
              title: "Marker replay",
              initialCwd: "/tmp",
              cols: message.cols,
              rows: message.rows,
            },
          });
        }
        return true;
      });
    const markerTerminal = await fixture.terminalSessions.createTerminal({
      payload: {
        cols: 80,
        rows: 24,
        target: { kind: "host_path", hostId: fixture.host.id, cwd: "/tmp" },
        title: "Marker replay",
      },
    });
    send.mockRestore();
    const marker = `\u001b]7717;bb-holder;${markerTerminal.id}\u0007`;
    const replayData = Buffer.alloc(384, "r").toString("base64");
    const chunks = Array.from({ length: 200_000 }, (_, seq) => ({
      seq,
      dataBase64:
        seq === 199_999
          ? Buffer.from(`${"r".repeat(280)}${marker}`).toString("base64")
          : replayData,
    }));
    const replay = Promise.resolve(
      fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "shutdown-marker-replay",
          terminalId: markerTerminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      }),
    );
    let replaySettled = false;
    void replay.then(() => {
      replaySettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replaySettled).toBe(false);
    const server = startHttpListener({
      fetch: async () => new Response("ok"),
      logger: fixture.harness.deps.logger,
      serverConfig: { BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: 0 },
    });
    await once(server, "listening");
    const result = await shutdownServerRuntime({
      closeWebSockets: async () => undefined,
      db: fixture.db,
      logger: fixture.harness.deps.logger,
      stopPeriodicUpdateChecks: async () => undefined,
      stopPlugins: async () => undefined,
      server,
      stopTerminalDataPlane: () => fixture.child.shutdown(),
      flushTerminalOutputBeforeClose: async (signal) => {
        await fixture.terminalSessions.flushRetainedOutputBeforeClose(signal);
      },
    });
    expect(result.completedWithinBounds).toBe(false);
    expect(replaySettled).toBe(false);
    await expect(replay).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        terminals: [expect.objectContaining({ terminalId: markerTerminal.id })],
      }),
      "Terminal output shutdown flush timed out; pending output was not written",
    );
  }, 15_000);

  it("logs a failed shutdown flush as failed rather than timed out", async () => {
    const fixture = await setup();
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    const chunks = replayChunks(20_000);
    const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "shutdown-failed-flush-replay",
        terminalId: fixture.terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const server = startHttpListener({
      fetch: async () => new Response("ok"),
      logger: fixture.harness.deps.logger,
      serverConfig: { BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: 0 },
    });
    await once(server, "listening");
    const result = await shutdownServerRuntime({
      closeWebSockets: async () => undefined,
      db: fixture.db,
      logger: fixture.harness.deps.logger,
      stopPeriodicUpdateChecks: async () => undefined,
      stopPlugins: async () => undefined,
      server,
      stopTerminalDataPlane: () => fixture.child.shutdown(),
      flushTerminalOutputBeforeClose: async (signal) => {
        void fixture.terminalSessions.flushRetainedOutputBeforeClose(signal);
        throw new Error("flush failed");
      },
    });
    expect(result.completedWithinBounds).toBe(false);
    await replay;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ terminals: expect.any(Array) }),
      "Terminal output shutdown flush failed; pending output was not written",
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Terminal output shutdown flush timed out; pending output was not written",
    );
    fixture.child.shutdown();
  }, 15_000);

  it("keeps exit expiry when replay yields across the exit flush", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chunks = replayChunks();
    try {
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "exit-during-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [
          {
            seq: 5_000,
            dataBase64: Buffer.from("before exit").toString("base64"),
          },
        ],
      });
      fixture.terminalSessions.closeRemovedHostTerminals({
        hostId: fixture.host.id,
      });
      await replay;
      await vi.advanceTimersByTimeAsync(1_000);

      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      const row = fixture.db.$client
        .prepare(
          "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(fixture.terminal.id) as { expiresAt: number | null } | undefined;
      expect(retained?.map(({ seq }) => seq)).toContain(5_000);
      expect(row?.expiresAt).toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 15_000);

  it("retains every replay chunk once when the terminal exits at a replay yield", async () => {
    const fixture = await setup();
    const attachSocket = new FakeSocket();
    const chunks = Array.from({ length: 1_024 }, (_, seq) => ({
      seq: seq + 10,
      dataBase64: Buffer.from(
        `replay-${seq.toString().padStart(4, "0")}\n`,
      ).toString("base64"),
    }));
    const initialPending = Array.from({ length: 3 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(`pending-${seq}\n`).toString("base64"),
    }));
    const outputDuringReplay = {
      seq: 2_000,
      dataBase64: Buffer.from("output-during-replay\n").toString("base64"),
    };
    try {
      let replaySettled = false;
      let replay: Promise<void> | undefined;
      let queueProgressed = false;
      let resolveQueueProgress!: () => void;
      const queueProgress = new Promise<void>((resolve) => {
        resolveQueueProgress = resolve;
      });
      const queue = createDaemonSocketMessageQueue({
        handle: async (message: () => void | Promise<void>) => message(),
        onError: (error) => {
          throw error;
        },
      });
      fixture.hub.registerDaemon(fixture.session.id, fixture.host.id, {
        close() {},
        send() {},
      });
      fixture.terminalSessions.attachBrowserTerminal({
        outputAcks: false,
        resizeAcks: false,
        socket: attachSocket,
        sinceSeq: 0,
        terminalId: fixture.terminal.id,
      });
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: initialPending,
      });
      queue.enqueue(() => {
        replay = Promise.resolve(
          fixture.terminalSessions.handleDaemonTerminalMessage({
            hostId: fixture.host.id,
            sessionId: fixture.session.id,
            message: {
              type: "terminal.replay",
              requestId: "exit-chunks-during-replay",
              terminalId: fixture.terminal.id,
              replayStartSeq: 10,
              nextSeq: chunks.at(-1)!.seq + 1,
              chunks,
            },
          }),
        ).finally(() => {
          replaySettled = true;
        });
        return replay;
      });
      queue.enqueue(() => {
        queueProgressed = true;
        resolveQueueProgress();
      });
      queue.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(replaySettled).toBe(false);
      expect(queueProgressed).toBe(false);
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [outputDuringReplay],
      });
      fixture.terminalSessions.closeRemovedHostTerminals({
        hostId: fixture.host.id,
      });
      await Promise.race([
        queueProgress,
        delay(5_000).then(() => {
          throw new Error("serialized daemon queue did not progress");
        }),
      ]);
      await replay;
      expect(replaySettled).toBe(true);
      expect(queueProgressed).toBe(true);
      await Promise.race([
        (async () => {
          while (attachSocket.sent.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(),
        delay(5_000).then(() => {
          throw new Error("pending attach caller did not settle");
        }),
      ]);
      expect(attachSocket.sent.map((data) => JSON.parse(data))).toContainEqual(
        expect.objectContaining({ type: "error", code: "terminal_closed" }),
      );

      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(retained).toEqual([
        ...initialPending,
        ...chunks,
        outputDuringReplay,
      ]);
      const terminal = getTerminalSession(fixture.db, {
        kind: "terminal",
        terminalId: fixture.terminal.id,
      });
      expect(terminal?.status).toBe("exited");
      expect(terminal?.daemonSessionId).toBeNull();
      const row = fixture.db.$client
        .prepare(
          "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(fixture.terminal.id) as { expiresAt: number | null } | undefined;
      expect(row?.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      fixture.child.shutdown();
    }
  }, 15_000);

  it("fails the pending attach and discards replay output after owner replacement", async () => {
    const fixture = await setup();
    const replayInfo = vi.spyOn(fixture.harness.deps.logger, "info");
    const replacement = seedSession(fixture.harness.deps, fixture.host.id, {
      instanceId: "replacement-instance",
    });
    const chunks = replayChunks();
    const pendingAttaches = Reflect.get(
      fixture.terminalSessions,
      "pendingAttaches",
    );
    if (
      typeof pendingAttaches !== "object" ||
      pendingAttaches === null ||
      !("claim" in pendingAttaches) ||
      typeof pendingAttaches.claim !== "function" ||
      !("settle" in pendingAttaches) ||
      typeof pendingAttaches.settle !== "function"
    ) {
      throw new Error("Terminal pending attach registry is unavailable");
    }
    const pendingAttachRegistry = pendingAttaches as {
      claim(key: Record<string, unknown>): { promise: Promise<unknown> };
      settle(key: string, result: unknown): boolean;
    };
    const requestId = "replaced-owner-replay";
    const rpcKey = `${fixture.session.id}\0${fixture.terminal.id}\0${requestId}`;
    const attachSocket = new FakeSocket();
    const attachSettlement = vi.spyOn(pendingAttachRegistry, "settle");
    const pendingAttach = pendingAttachRegistry
      .claim({
        daemonSessionId: fixture.session.id,
        requestId,
        rpcKey,
        socket: attachSocket,
        terminalId: fixture.terminal.id,
      })
      .promise.catch((error: unknown) => error);
    try {
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId,
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      updateTerminalSession(fixture.db, {
        scope: { kind: "terminal", terminalId: fixture.terminal.id },
        update: { kind: "reconnect", daemonSessionId: replacement.id },
      });
      const [attachError] = await Promise.race([
        Promise.all([pendingAttach, replay]),
        delay(5_000).then(() => {
          throw new Error("replacement-owner replay did not settle");
        }),
      ]);

      expect(attachError).toMatchObject({
        status: 409,
        body: { code: "terminal_replaced" },
      });
      expect(attachSettlement).not.toHaveBeenCalled();
      expect(attachSocket.sent).toEqual([
        expect.stringContaining('"code":"terminal_replaced"'),
      ]);

      expect(
        getRetainedTerminalOutput(fixture.db, {
          hostId: fixture.host.id,
          terminalSessionId: fixture.terminal.id,
          now: Date.now(),
        }) ?? [],
      ).toEqual([]);
      expect(
        getTerminalSession(fixture.db, {
          kind: "terminal",
          terminalId: fixture.terminal.id,
        }),
      ).toMatchObject({
        status: "running",
        daemonSessionId: replacement.id,
      });
      expect(
        replayInfo.mock.calls.some(
          ([, message]) => message === "Terminal replay attributed",
        ),
      ).toBe(false);
      const discard = replayInfo.mock.calls.find(
        ([, message]) =>
          message === "Terminal replay discarded after ownership change",
      );
      expect(discard).toBeDefined();
      expect(discard?.[0]).not.toHaveProperty("retainedWriteBytes");
      expect(discard?.[0]).not.toHaveProperty("retainedWriteChunks");
    } finally {
      fixture.child.shutdown();
    }
  }, 15_000);

  it("attributes an empty catch-up replay without retained writes", async () => {
    const fixture = await setup();
    const replayInfo = vi.spyOn(fixture.harness.deps.logger, "info");
    const pendingCatchUps = Reflect.get(
      fixture.terminalSessions,
      "pendingCatchUps",
    );
    if (
      typeof pendingCatchUps !== "object" ||
      pendingCatchUps === null ||
      !("claim" in pendingCatchUps) ||
      typeof pendingCatchUps.claim !== "function"
    ) {
      throw new Error("Terminal pending catch-up registry is unavailable");
    }
    const pendingCatchUpRegistry = pendingCatchUps as {
      claim(key: Record<string, unknown>): { promise: Promise<unknown> };
    };
    const requestId = "empty-catch-up-replay";
    const rpcKey = `${fixture.session.id}\0${fixture.terminal.id}\0${requestId}`;
    const pendingCatchUp = pendingCatchUpRegistry.claim({
      daemonSessionId: fixture.session.id,
      requestId,
      rpcKey,
      terminalId: fixture.terminal.id,
    }).promise;
    try {
      await fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId,
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: 0,
          chunks: [],
        },
      });
      await expect(pendingCatchUp).resolves.toMatchObject({ chunks: [] });

      const attribution = replayInfo.mock.calls.find(
        ([, message]) => message === "Terminal replay attributed",
      );
      expect(attribution).toBeDefined();
      expect(attribution?.[0]).toMatchObject({
        callers: ["catch-up"],
        retainedWriteBytes: 0,
        retainedWriteChunks: 0,
        maxRetainedWriteBatchBytes: 0,
        maxRetainedWriteBatchChunks: 0,
      });
    } finally {
      fixture.child.shutdown();
    }
  });

  it("restores expiry when the deferred timer flush appends output after exit", async () => {
    const fixture = await setup();
    const replacement = seedSession(fixture.harness.deps, fixture.host.id, {
      instanceId: "replacement-instance",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const original = {
      seq: 0,
      dataBase64: Buffer.from("old").toString("base64"),
    };
    const pending = {
      seq: 1,
      dataBase64: Buffer.from("pending").toString("base64"),
    };
    const replayForExpiry = replayChunks(1_024).map((chunk) => ({
      ...chunk,
      seq: chunk.seq + 2,
    }));
    try {
      appendRetainedTerminalOutputChunks(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        chunks: [original],
        clock: Date.now,
      });
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [pending],
      });
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "deferred-expiry-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: replayForExpiry[0]!.seq,
          nextSeq: replayForExpiry.at(-1)!.seq + 1,
          chunks: replayForExpiry,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.terminalSessions.closeRemovedHostTerminals({
        hostId: fixture.host.id,
      });
      fixture.db.$client
        .prepare(
          "UPDATE terminal_sessions SET daemon_session_id = ? WHERE id = ?",
        )
        .run(replacement.id, fixture.terminal.id);
      await replay;
      await vi.advanceTimersByTimeAsync(1_000);

      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(retained?.map(({ seq }) => seq)).toEqual([
        original.seq,
        pending.seq,
      ]);
      const row = fixture.db.$client
        .prepare(
          "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(fixture.terminal.id) as { expiresAt: number | null } | undefined;
      expect(row?.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 15_000);

  it("retains replay output when the environment is destroyed during a replay yield", async () => {
    await retainReplayAcrossLifecycleTransition({
      setup: { environmentBacked: true },
      transition: (fixture) => {
        if (!fixture.environment)
          throw new Error("environment fixture missing");
        fixture.terminalSessions.closeDestroyedEnvironmentTerminals({
          environmentId: fixture.environment.id,
        });
      },
      expectedStatus: "exited",
    });
  }, 15_000);

  it("retains replay output when a starting terminal disconnects during a yield", async () => {
    await retainReplayAcrossLifecycleTransition({
      setup: { terminalStatus: "starting" },
      transition: (fixture) => {
        fixture.terminalSessions.handleDaemonSessionClosed({
          sessionId: fixture.session.id,
        });
      },
      expectedStatus: "disconnected",
    });
  }, 15_000);

  it("removes maintained screens on every running-session stop path", async () => {
    type Fixture = Awaited<ReturnType<typeof setup>>;
    const assertRemoved = async (
      stop: (fixture: Fixture) => void | Promise<void>,
      options: { environmentBacked?: boolean; threadless?: boolean } = {},
    ) => {
      const fixture = await setup(options);
      const screenStates = seedMaintainedScreen(fixture);
      try {
        expect(screenStates.has(fixture.terminal.id)).toBe(true);
        await stop(fixture);
        expect(screenStates.has(fixture.terminal.id)).toBe(false);
      } finally {
        fixture.child.shutdown();
      }
    };

    await assertRemoved((fixture) =>
      fixture.terminalSessions.closeDeletedThreadTerminals({
        threadId: fixture.thread.id,
      }),
    );
    await assertRemoved((fixture) =>
      fixture.terminalSessions.closeArchivedThreadTerminals({
        threadId: fixture.thread.id,
      }),
    );
    await assertRemoved(
      (fixture) => {
        if (fixture.environment === null)
          throw new Error("environment fixture missing");
        fixture.terminalSessions.closeDestroyedEnvironmentTerminals({
          environmentId: fixture.environment.id,
        });
      },
      { environmentBacked: true },
    );
    await assertRemoved(
      (fixture) =>
        fixture.terminalSessions.closeRemovedHostTerminals({
          hostId: fixture.host.id,
        }),
      { threadless: true },
    );
    await assertRemoved(async (fixture) => {
      updateTerminalSession(fixture.db, {
        scope: {
          kind: "terminal",
          statuses: ["running"],
          terminalId: fixture.terminal.id,
        },
        update: { daemonSessionId: null },
      });
      await fixture.terminalSessions.closeTerminal({
        terminalId: fixture.terminal.id,
        payload: { mode: "force", reason: "user" },
      });
    });
    await assertRemoved((fixture) =>
      fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: fixture.terminal.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      }),
    );
    await assertRemoved((fixture) =>
      fixture.terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.session.id,
      }),
    );
    await assertRemoved((fixture) => {
      const controller = new AbortController();
      controller.abort("failed");
      fixture.terminalSessions.flushRetainedOutputBeforeClose(
        controller.signal,
      );
    });
    await assertRemoved(async (fixture) => {
      fixture.terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.session.id,
      });
      const replacement = seedSession(fixture.harness.deps, fixture.host.id, {
        instanceId: "replacement-instance",
      });
      await fixture.terminalSessions.reconcileDisconnectedHostTerminals({
        hostId: fixture.host.id,
        daemonSessionId: replacement.id,
      });
    });
  });

  it("serves replay fallback after a screen state exceeds its pending byte limit", async () => {
    const fixture = await setup();
    const screenStates = Reflect.get(
      fixture.terminalSessions,
      "terminalScreenStates",
    );
    try {
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from("replay fallback").toString("base64"),
          },
        ],
      });
      fixture.terminalSessions.flushAllRetainedOutput();
      screenStates.push(
        fixture.terminal.id,
        fixture.terminal.cols,
        fixture.terminal.rows,
        1,
        Buffer.alloc(8 * 1024 * 1024, 120),
      );
      updateTerminalSession(fixture.db, {
        scope: {
          kind: "terminal",
          statuses: ["running"],
          terminalId: fixture.terminal.id,
        },
        update: { kind: "exit" },
      });

      const response = await fixture.harness.app.request(
        `/api/v1/terminals/${fixture.terminal.id}/screen?threadId=${fixture.thread.id}`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        rows: expect.arrayContaining(["replay fallback"]),
        complete: true,
      });
    } finally {
      fixture.child.shutdown();
    }
  });

  it("retains pending, replay, and concurrent running output in sequence order", async () => {
    const fixture = await setup();
    const pending = [
      { seq: 0, dataBase64: Buffer.from("pending-0").toString("base64") },
      { seq: 1, dataBase64: Buffer.from("pending-1").toString("base64") },
    ];
    const chunks = Array.from({ length: 1_024 }, (_, index) => ({
      seq: index + 10,
      dataBase64: Buffer.from(`replay-${index}`).toString("base64"),
    }));
    const duringReplay = {
      seq: 5,
      dataBase64: Buffer.from("running-output-during-replay").toString(
        "base64",
      ),
    };
    try {
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: pending,
      });
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "running-three-source-order",
          terminalId: fixture.terminal.id,
          replayStartSeq: 10,
          nextSeq: chunks.at(-1)!.seq + 1,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [duringReplay],
      });
      await Promise.race([
        replay,
        delay(5_000).then(() => {
          throw new Error("running terminal replay did not settle");
        }),
      ]);

      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      const expected = [...pending, ...chunks, duringReplay].sort(
        (left, right) => left.seq - right.seq,
      );
      expect(retained).toHaveLength(expected.length);
      expect(retained).toEqual(expected);
      expect(new Set(retained?.map(({ seq }) => seq)).size).toBe(
        expected.length,
      );
      expect(
        getTerminalSession(fixture.db, {
          kind: "terminal",
          terminalId: fixture.terminal.id,
        })?.status,
      ).toBe("running");
    } finally {
      fixture.child.shutdown();
    }
  }, 15_000);

  it("preserves pending output when a synthetic host change occurs at the replay yield", async () => {
    const fixture = await setup();
    const replacementHost = seedHostSession(fixture.harness.deps).host;
    const pending = {
      seq: 1,
      dataBase64: Buffer.from("pending-before-host-change").toString("base64"),
    };
    const chunks = replayChunks();
    try {
      fixture.terminalSessions.recordDirectTerminalOutputBatch({
        daemonSessionId: fixture.session.id,
        terminalId: fixture.terminal.id,
        chunks: [pending],
      });
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "host-change-at-yield",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.db.$client
        .prepare("UPDATE terminal_sessions SET host_id = ? WHERE id = ?")
        .run(replacementHost.id, fixture.terminal.id);
      await replay;
      fixture.db.$client
        .prepare("UPDATE terminal_sessions SET host_id = ? WHERE id = ?")
        .run(fixture.host.id, fixture.terminal.id);
      fixture.terminalSessions.flushAllRetainedOutput();

      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(retained?.map(({ seq }) => seq)).toEqual([pending.seq]);
    } finally {
      fixture.child.shutdown();
    }
  }, 15_000);

  it("does not append replay output after a synthetic sequence offset change", async () => {
    const fixture = await setup();
    const sequenceRebase = (
      fixture.terminalSessions as unknown as {
        outputSequenceRebase: {
          setBase(terminalId: string, base: number): void;
        };
      }
    ).outputSequenceRebase;
    const chunks = replayChunks();
    try {
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "offset-change-at-yield",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      sequenceRebase.setBase(fixture.terminal.id, 17);
      await replay;

      expect(
        getRetainedTerminalOutput(fixture.db, {
          hostId: fixture.host.id,
          terminalSessionId: fixture.terminal.id,
          now: Date.now(),
        }) ?? [],
      ).toEqual([]);
    } finally {
      sequenceRebase.setBase(fixture.terminal.id, 0);
      fixture.child.shutdown();
    }
  }, 15_000);

  it("does not resurrect dismissed output when replay finishes", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chunks = replayChunks();
    try {
      fixture.db.$client
        .prepare(
          "UPDATE terminal_sessions SET status = 'exited', close_reason = 'process-exit' WHERE id = ?",
        )
        .run(fixture.terminal.id);
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "dismiss-during-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const dismiss = fixture.terminalSessions.closeTerminal({
        terminalId: fixture.terminal.id,
        payload: { mode: "force", reason: "user" },
      });
      await replay;
      await dismiss;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        listTerminalSessions(fixture.db, {
          scope: { kind: "thread", threadId: fixture.thread.id },
          visible: true,
        }).map(({ id }) => id),
      ).not.toContain(fixture.terminal.id);
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 15_000);

  it("reads the completed retained output when a read overlaps replay", async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chunks = replayChunks();
    try {
      fixture.db.$client
        .prepare(
          "UPDATE terminal_sessions SET status = 'exited', close_reason = 'process-exit' WHERE id = ?",
        )
        .run(fixture.terminal.id);
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "read-during-replay",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const read = fixture.terminalSessions
        .readTerminalOutput({
          terminalId: fixture.terminal.id,
          query: {},
        })
        .then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        );
      await replay;
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await read;
      expect(result).toHaveProperty("output");
      if (!("output" in result)) throw result.error;
      expect(result.output.chunks.at(-1)?.seq).toBe(chunks.length - 1);
    } finally {
      vi.useRealTimers();
      fixture.child.shutdown();
    }
  }, 15_000);

  it("bounds replay catch-up while preserving output arriving at every yield and a queued daemon message", async () => {
    const fixture = await setup();
    const queue = createDaemonSocketMessageQueue<() => void | Promise<void>>({
      handle: (message) => message(),
      onError: (error) => {
        throw error;
      },
    });
    queue.release();
    let yieldCount = 0;
    let nextYield = deferred<number>();
    let waitingForYield = nextYield.promise;
    let releaseYield: () => void = () => {};
    let yieldHeld = false;
    try {
      const injectedSeqs: number[] = [];
      let queuedMessageProcessed = false;
      let resolveQueuedMessage!: () => void;
      let resolveReplayFinished!: () => void;
      const queuedMessage = new Promise<void>((resolve) => {
        resolveQueuedMessage = resolve;
      });
      const replayFinished = new Promise<void>((resolve) => {
        resolveReplayFinished = resolve;
      });
      replayYieldControl.intercept = () => {
        yieldCount += 1;
        const signal = nextYield;
        nextYield = deferred<number>();
        signal.resolve(yieldCount);
        return new Promise<void>((resolve) => {
          releaseYield = resolve;
          yieldHeld = true;
        });
      };
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
        ).then(() => resolveReplayFinished()),
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

      while (true) {
        const next = await Promise.race([
          waitingForYield.then((yieldNumber) => ({ yieldNumber })),
          replayFinished.then(() => ({ done: true as const })),
          delay(5_000).then(() => {
            throw new Error(`replay stalled after ${yieldCount} yields`);
          }),
        ]);
        if ("done" in next) break;
        const actualYield = next.yieldNumber;
        waitingForYield = nextYield.promise;
        expect(actualYield).toBe(yieldCount);
        const seq = 100_000 + actualYield;
        injectedSeqs.push(seq);
        fixture.terminalSessions.recordDirectTerminalOutputBatch({
          daemonSessionId: fixture.session.id,
          terminalId: fixture.terminal.id,
          chunks: [
            {
              seq,
              dataBase64: Buffer.from(`yield-${actualYield}`).toString(
                "base64",
              ),
            },
          ],
        });
        if (!yieldHeld)
          throw new Error(`replay yield ${actualYield} was not held`);
        yieldHeld = false;
        releaseYield();
      }

      const completedWithinBound = await Promise.race([
        queuedMessage.then(() => true),
        delay(5_000).then(() => false),
      ]);
      if (!completedWithinBound) {
        await Promise.race([queuedMessage, delay(5_000)]);
      }

      expect(completedWithinBound).toBe(true);
      expect(queuedMessageProcessed).toBe(true);
      expect(yieldCount).toBeGreaterThanOrEqual(200);
      expect(injectedSeqs).toHaveLength(yieldCount);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(1_000);
      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      const retainedSeqs = retained?.map(({ seq }) => seq) ?? [];
      const expectedSeqs = [
        ...replayChunks.map(({ seq }) => seq),
        ...injectedSeqs,
      ];
      expect(retainedSeqs).toEqual(expectedSeqs);
      expect(new Set(retainedSeqs).size).toBe(retainedSeqs.length);
    } finally {
      replayYieldControl.intercept = null;
      if (yieldHeld) releaseYield();
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

  it("trims 256 Ki one-byte chunks within 500 ms slices, 1,000 ms event-loop gaps, and 10,100 ms total", async () => {
    const fixture = await setup();
    const chunkCount = TERMINAL_RETAINED_OUTPUT_BYTES * 4;
    const chunks = Array.from({ length: chunkCount }, (_, seq) => ({
      seq,
      dataBase64: "eA==",
    }));
    let probeRunning = true;
    let previousProbeAt = performance.now();
    let previousTimerProbeAt = previousProbeAt;
    let longestSynchronousSliceMs = 0;
    let longestEventLoopGapMs = 0;
    let timerProbe: ReturnType<typeof setTimeout> | undefined;
    const replayStartedAt = performance.now();
    const probe = () => {
      if (!probeRunning) return;
      const now = performance.now();
      longestSynchronousSliceMs = Math.max(
        longestSynchronousSliceMs,
        now - previousProbeAt,
      );
      previousProbeAt = now;
      setImmediate(probe);
    };
    const timerProbeTick = () => {
      if (!probeRunning) return;
      const now = performance.now();
      longestEventLoopGapMs = Math.max(
        longestEventLoopGapMs,
        now - previousTimerProbeAt,
      );
      previousTimerProbeAt = now;
      timerProbe = setTimeout(timerProbeTick, 10);
    };
    try {
      setImmediate(probe);
      timerProbe = setTimeout(timerProbeTick, 10);
      takeEventLoopWorkWindowSnapshot();
      const replay = fixture.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: "linear-tail-trim-bound",
          terminalId: fixture.terminal.id,
          replayStartSeq: 0,
          nextSeq: chunkCount,
          chunks,
        },
      });
      let replayFinishedAt: number | undefined;
      if (!(replay instanceof Promise)) {
        throw new Error("terminal.replay handler must return a promise");
      }
      const replayCompletion = replay.then(() => {
        replayFinishedAt = performance.now();
        return true;
      });
      await replayCompletion;
      const totalCompletionMs =
        replayFinishedAt === undefined
          ? null
          : replayFinishedAt - replayStartedAt;
      probeRunning = false;
      if (timerProbe !== undefined) clearTimeout(timerProbe);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const replayWork = takeEventLoopWorkWindowSnapshot();
      const measuredSliceMs = Math.max(
        longestSynchronousSliceMs,
        replayWork.longestSynchronousWorkWallMs ?? 0,
      );
      process.stdout.write(
        `G4-MEASURE slice_ms=${measuredSliceMs.toFixed(1)} gap_ms=${longestEventLoopGapMs.toFixed(1)} total_ms=${totalCompletionMs?.toFixed(1) ?? "missing"} total_bound_ms=10100 fixed_worst_ms=2504.8 bound_factor=4 bound_rounding_ms=100\n`,
      );
      expect(totalCompletionMs).not.toBeNull();
      expect(totalCompletionMs).toBeLessThanOrEqual(10_100);
      expect(measuredSliceMs).toBeLessThanOrEqual(500);
      expect(longestEventLoopGapMs).toBeLessThanOrEqual(1_000);
      const retained = getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      });
      expect(
        retained?.map(({ seq, dataBase64 }) => ({ seq, dataBase64 })),
      ).toEqual(chunks.slice(-TERMINAL_RETAINED_OUTPUT_BYTES));
    } finally {
      probeRunning = false;
      if (timerProbe !== undefined) clearTimeout(timerProbe);
      fixture.child.shutdown();
    }
  }, 40_000);

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
