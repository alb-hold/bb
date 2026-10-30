import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { handOffTerminalUpgrade } from "../../src/ws/terminal-upgrade-handoff.js";
import { TerminalDataPlaneRouter } from "../../src/services/terminals/data-plane/data-plane-router.js";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION as V,
  type TerminalDataPlaneMainMessage,
} from "../../src/terminal-data-plane/ipc-contract.js";
import { createTerminalSession, updateTerminalSession } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonServerWsMessage } from "@bb/host-daemon-contract";
import { onTerminalSocketOpen } from "../../src/ws/terminal-protocol.js";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const harnesses: TestAppHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  vi.restoreAllMocks();
});

function attributedFailures(lifecycle: object) {
  const failures: unknown = Reflect.get(lifecycle, "attributedAttachFailures");
  if (!(failures instanceof Set || failures instanceof Map))
    throw new Error("Attach attribution failure storage is unavailable");
  return failures;
}

async function setup(terminalAttachTimeoutMs?: number) {
  const db = createMigratedConnection();
  const harness = await createTestAppHarness({ db, terminalAttachTimeoutMs });
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps);
  const terminal = createTerminalSession(db, {
    cols: 80,
    rows: 24,
    hostId: host.id,
    daemonSessionId: session.id,
    environmentId: null,
    threadId: null,
    initialCwd: "/tmp",
    title: "attribution",
    status: "running",
  });
  const requests: HostDaemonServerWsMessage[] = [];
  harness.hub.registerDaemon(session.id, host.id, {
    close() {},
    send(data) {
      requests.push(JSON.parse(String(data)));
    },
  });
  const info = vi.spyOn(harness.deps.logger, "info");
  const lines = () =>
    info.mock.calls.filter(
      ([, message]) => message === "Terminal replay attributed",
    );
  const reply = async () => {
    const request = [...requests]
      .reverse()
      .find((message) => message.type === "terminal.attach");
    if (request?.type !== "terminal.attach")
      throw new Error("No terminal attach request");
    await harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: host.id,
      sessionId: session.id,
      message: {
        type: "terminal.replay",
        terminalId: terminal.id,
        requestId: request.requestId,
        replayStartSeq: 0,
        nextSeq: 1,
        chunks: [
          { seq: 0, dataBase64: Buffer.from("replay").toString("base64") },
        ],
      },
    });
  };
  return { harness, host, session, terminal, requests, lines, reply, info };
}

describe("terminal replay attribution paths", () => {
  it.each(["websocket", "data-plane"] as const)(
    "attributes exactly one %s replay",
    async (path) => {
      const fixture = await setup();
      const socket = { close: vi.fn(), send: vi.fn() };
      if (path === "data-plane") {
        fixture.harness.deps.terminalSessions.markDirectOutputSocket(socket);
        fixture.harness.deps.terminalSessions.setDaemonSessionDirectOutput({
          daemonSessionId: fixture.session.id,
          enabled: true,
        });
      }
      onTerminalSocketOpen(fixture.harness.deps, {
        terminalId: fixture.terminal.id,
        socket,
        sinceSeq: 0,
        outputAcks: false,
        resizeAcks: false,
      });
      await fixture.reply();
      expect(
        socket.send.mock.calls.some(
          ([data]) => JSON.parse(data).type === "attached",
        ),
      ).toBe(true);
      expect(fixture.lines()).toHaveLength(1);
      expect(fixture.lines()[0]?.[0]).toMatchObject({
        path,
        callers: ["terminal-attach"],
        replayBytes: 6,
        replayChunks: 1,
      });
    },
  );

  it("attributes exactly one output-read replay", async () => {
    const fixture = await setup();
    const output = fixture.harness.deps.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    await fixture.reply();
    expect((await output).chunks).toHaveLength(1);
    expect(fixture.lines()).toHaveLength(1);
    expect(fixture.lines()[0]?.[0]).toMatchObject({
      path: "output-read",
      callers: ["output-read"],
      replayBytes: 6,
    });
  });
  it("attributes exactly one reconnect catch-up replay", async () => {
    const f = await setup();
    const socket = { close: vi.fn(), send: vi.fn() };
    onTerminalSocketOpen(f.harness.deps, {
      terminalId: f.terminal.id,
      socket,
      sinceSeq: 0,
      outputAcks: false,
      resizeAcks: false,
    });
    await f.reply();
    f.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: f.session.id,
    });
    f.info.mockClear();
    await f.harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
      hostId: f.host.id,
      daemonSessionId: f.session.id,
    });
    await f.reply();
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]?.[0]).toMatchObject({
      path: "catch-up",
      callers: ["catch-up"],
      replayBytes: 6,
    });
  });

  it.each(["disconnect", "exit"] as const)(
    "attributes a local %s attach without daemon replay",
    async (kind) => {
      const f = await setup();
      updateTerminalSession(f.harness.db, {
        scope: { kind: "terminal", terminalId: f.terminal.id },
        update:
          kind === "disconnect"
            ? { kind, retainDaemonSession: true }
            : { kind, closeReason: "user", exitCode: 0 },
      });
      const socket = { close: vi.fn(), send: vi.fn() };
      onTerminalSocketOpen(f.harness.deps, {
        terminalId: f.terminal.id,
        socket,
        sinceSeq: 0,
        outputAcks: false,
        resizeAcks: false,
      });
      expect(
        socket.send.mock.calls.some(
          ([data]) => JSON.parse(data).type === "attached",
        ),
      ).toBe(true);
      expect(
        f.requests.filter((request) => request.type === "terminal.attach"),
      ).toHaveLength(0);
      expect(f.lines()).toHaveLength(1);
      expect(f.lines()[0]?.[0]).toMatchObject({
        path:
          kind === "disconnect"
            ? "websocket/disconnected"
            : "websocket/inactive",
        replayBytes: 0,
      });
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "attributes a %s attach once even if replay arrives late",
    async (outcome) => {
      const f = await setup();
      const socket = { close: vi.fn(), send: vi.fn() };
      onTerminalSocketOpen(f.harness.deps, {
        terminalId: f.terminal.id,
        socket,
        sinceSeq: 0,
        outputAcks: false,
        resizeAcks: false,
      });
      if (outcome === "cancelled")
        f.harness.deps.terminalSessions.detachBrowserTerminal({
          terminalId: f.terminal.id,
          socket,
        });
      else
        f.harness.deps.terminalSessions.handleDaemonSessionClosed({
          sessionId: f.session.id,
        });
      expect(f.lines()).toHaveLength(1);
      await f.reply();
      expect(attributedFailures(f.harness.deps.terminalSessions).size).toBe(0);
      expect(f.lines()).toHaveLength(1);
      expect(f.lines()[0]?.[0]).toMatchObject({
        path: `websocket/${outcome}`,
        callers: ["terminal-attach"],
        replayBytes: 0,
      });
    },
  );

  it("attributes one upgrade handoff replay through the data-plane router", async () => {
    const f = await setup();
    const lifecycle = f.harness.deps.terminalSessions;
    lifecycle.setDaemonSessionDirectOutput({
      daemonSessionId: f.session.id,
      enabled: true,
    });
    const sent: TerminalDataPlaneMainMessage[] = [];
    const router = new TerminalDataPlaneRouter(
      {
        isReady: true,
        pendingIpcBytes: 0,
        send(message) {
          sent.push(message);
          return true;
        },
      },
      {
        attach(args) {
          lifecycle.markDirectOutputSocket(args.socket);
          onTerminalSocketOpen(f.harness.deps, args);
        },
        detach: (args) => lifecycle.detachBrowserTerminal(args),
        handleMessage: (args) => lifecycle.handleBrowserTerminalMessage(args),
        recordInputActivity: (id) => lifecycle.recordDirectTerminalInput(id),
        recordOutputBatch: (args) =>
          lifecycle.recordDirectTerminalOutputBatch(args),
        stripHolderMarkersFromDataPlaneOutput: (id, chunk) =>
          lifecycle.stripHolderMarkersFromDataPlaneOutput(id, chunk),
      },
      () => undefined,
    );
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.url = `/ws/terminals/${f.terminal.id}`;
    request.method = "GET";
    request.headers = { host: "localhost:3001", upgrade: "websocket" };
    request.rawHeaders = ["Host", "localhost:3001", "Upgrade", "websocket"];
    try {
      expect(
        handOffTerminalUpgrade(
          {
            attach: (args) => router.attachBrowser(args),
            guard: {
              config: {
                serverPort: 3001,
                appUrl: undefined,
                devAppPort: undefined,
              },
            },
            isAvailable: () => true,
            handleDataSocketUpgrade: () => false,
            resolveTerminal: (id) => lifecycle.resolveRunningTerminalRoute(id),
          },
          request,
          socket,
          Buffer.alloc(0),
        ),
      ).toBe(true);
      const attach = sent.find((message) => message.type === "browser.attach");
      if (attach?.type !== "browser.attach")
        throw new Error("No upgrade handoff");
      router.handleChildMessage({
        v: V,
        type: "browser.attached",
        attachId: attach.attachId,
      });
      await f.reply();
      await Promise.resolve();
      expect(
        sent.filter((message) => message.type === "browser.replay"),
      ).toHaveLength(1);
      expect(f.lines()).toHaveLength(1);
      expect(f.lines()[0]?.[0]).toMatchObject({
        path: "data-plane",
        callers: ["terminal-attach"],
        replayBytes: 6,
      });
      f.info.mockClear();
      router.handleChildMessage({
        v: V,
        type: "browser.resync",
        attachId: attach.attachId,
        terminalId: f.terminal.id,
        fromSeq: 1,
      });
      await f.reply();
      await Promise.resolve();
      expect(
        sent.filter((message) => message.type === "browser.replay"),
      ).toHaveLength(2);
      expect(f.lines()).toHaveLength(1);
      expect(f.lines()[0]?.[0]).toMatchObject({
        path: "data-plane",
        callers: ["terminal-attach"],
        replayBytes: 6,
      });
    } finally {
      router.handleChildDown();
      socket.destroy();
    }
  });
  it("attributes a retained output read once without a daemon request", async () => {
    const f = await setup();
    await f.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: f.host.id,
      sessionId: f.session.id,
      message: {
        type: "terminal.output",
        terminalId: f.terminal.id,
        chunk: { seq: 0, dataBase64: Buffer.from("saved").toString("base64") },
      },
    });
    updateTerminalSession(f.harness.db, {
      scope: { kind: "terminal", terminalId: f.terminal.id },
      update: { kind: "exit", exitCode: 0, closeReason: "user" },
    });
    f.info.mockClear();
    expect(
      (
        await f.harness.deps.terminalSessions.readTerminalOutput({
          terminalId: f.terminal.id,
          query: {},
        })
      ).chunks,
    ).toHaveLength(1);
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]?.[0]).toMatchObject({
      path: "output-read/retained",
      callers: ["output-read"],
      replayBytes: 5,
    });
  });

  it("attributes a timed out attach once before a late replay", async () => {
    const f = await setup(30);
    const socket = { close: vi.fn(), send: vi.fn() };
    onTerminalSocketOpen(f.harness.deps, {
      terminalId: f.terminal.id,
      socket,
      sinceSeq: 0,
      outputAcks: false,
      resizeAcks: false,
    });
    await vi.waitFor(() => expect(f.lines()).toHaveLength(1), { interval: 1 });
    await f.reply();
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]?.[0]).toMatchObject({
      path: "websocket/failed",
      replayBytes: 0,
    });
  });

  it("attributes a send failure once while holding the socket for reconnect", async () => {
    const f = await setup();
    vi.spyOn(f.harness.hub, "sendDaemonSessionMessage").mockReturnValue(false);
    const socket = { close: vi.fn(), send: vi.fn() };
    onTerminalSocketOpen(f.harness.deps, {
      terminalId: f.terminal.id,
      socket,
      sinceSeq: 0,
      outputAcks: false,
      resizeAcks: false,
    });
    expect(
      socket.send.mock.calls.some(
        ([data]) => JSON.parse(data).type === "attached",
      ),
    ).toBe(true);
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]?.[0]).toMatchObject({
      path: "websocket/send-failed",
      replayBytes: 0,
    });
  });

  it("attributes an unsolicited replay once as unmatched", async () => {
    const f = await setup();
    await f.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: f.host.id,
      sessionId: f.session.id,
      message: {
        type: "terminal.replay",
        terminalId: f.terminal.id,
        requestId: "unsolicited",
        replayStartSeq: 0,
        nextSeq: 0,
        chunks: [],
      },
    });
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]?.[0]).toMatchObject({
      path: "unmatched",
      callers: ["unmatched"],
      replayBytes: 0,
    });
  });
  it("expires repeated cancelled attach attributions when no replay arrives", async () => {
    const f = await setup(30);
    const lifecycle = f.harness.deps.terminalSessions;
    const failures = attributedFailures(lifecycle);
    const attempts = 32;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const socket = { close() {}, send() {} };
      onTerminalSocketOpen(f.harness.deps, {
        terminalId: f.terminal.id,
        socket,
        sinceSeq: 0,
        outputAcks: false,
        resizeAcks: false,
      });
      lifecycle.detachBrowserTerminal({ terminalId: f.terminal.id, socket });
    }
    expect(f.lines()).toHaveLength(attempts);
    expect(failures.size).toBe(attempts);
    await vi.waitFor(() => expect(failures.size).toBe(0), {
      timeout: 2_000,
      interval: 5,
    });
    expect(f.lines()).toHaveLength(attempts);
  });
});
