import { eq } from "drizzle-orm";
import { buildHostDaemonWebSocketProtocols } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL } from "@bb/server-contract";
import {
  createTerminalSession,
  getRetainedTerminalOutput,
  getSessionById,
  hostDaemonSessions,
} from "@bb/db";
import {
  createTestDaemonHostKey,
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";

let server: RunningTestServer | null = null;
const sockets = new Set<WebSocket>();

async function connectDaemon(
  sessionId: string,
  hostId: string,
  protocols = buildHostDaemonWebSocketProtocols(),
): Promise<WebSocket> {
  if (!server) throw new Error("test server is not running");
  const url = new URL("/internal/ws", server.baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("sessionId", sessionId);
  const socket = new WebSocket(url, protocols, {
    headers: { authorization: `Bearer ${createTestDaemonHostKey({ hostId })}` },
  });
  sockets.add(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return socket;
}

async function waitForClose(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("socket did not close")),
      1_000,
    );
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
    socket.once("error", reject);
  });
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.terminate();
  }
  sockets.clear();
  if (server) {
    await server.close();
    server = null;
  }
});

describe("daemon websocket session authorization", () => {
  it("applies the server protocol handler on the daemon socket", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const socket = await connectDaemon(session.id, host.id, [
      ...buildHostDaemonWebSocketProtocols(),
      TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
    ]);

    expect(socket.protocol).toBe(TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL);
  });

  it("a real daemon offer negotiates the daemon protocol", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const socket = await connectDaemon(session.id, host.id);

    expect(socket.protocol).toBe(buildHostDaemonWebSocketProtocols()[0]);
  });

  it("rejects closed-session frames before terminal, environment, RPC, or plugin effects", async () => {
    server = await startTestServer();
    const environmentFixture = seedHostSession(server.deps);
    const { project } = seedProjectWithSource(server.deps, {
      hostId: environmentFixture.host.id,
    });
    const environment = seedEnvironment(server.deps, {
      hostId: environmentFixture.host.id,
      projectId: project.id,
    });
    const terminalMessage = vi.spyOn(
      server.deps.terminalSessions,
      "handleDaemonTerminalMessage",
    );
    const environmentChange = vi.spyOn(server.hub, "notifyEnvironment");
    const rpcResponse = vi.spyOn(server.hub, "recordHostOnlineRpcResponse");
    const pluginSignal = vi.spyOn(server.pluginService, "handleHostSignal");
    const cases = [
      {
        message: {
          type: "terminal.exited",
          terminalId: "terminal-after-close",
          exitCode: 0,
          closeReason: "process-exit",
        },
        effect: terminalMessage,
        fixture: undefined,
      },
      {
        message: {
          type: "environment-change",
          environmentId: environment.id,
          change: "work-status-changed",
        },
        effect: environmentChange,
        fixture: environmentFixture,
      },
      {
        message: {
          type: "host-rpc.response",
          requestId: "closed-session-response",
          commandType: "host.list_files",
          ok: true,
          result: { files: [], truncated: false },
        },
        effect: rpcResponse,
        fixture: undefined,
      },
      {
        message: {
          type: "plugin-host.signal",
          pluginId: "closed-session-plugin",
          generation: "generation-1",
          signal: "signal",
          payload: {},
        },
        effect: pluginSignal,
        fixture: undefined,
      },
    ];

    for (const { message, effect, fixture } of cases) {
      const { host, session } = fixture ?? seedHostSession(server.deps);
      const socket = await connectDaemon(session.id, host.id);
      const recordActivity = vi.spyOn(server.hub, "recordDaemonActivity");
      server.db
        .update(hostDaemonSessions)
        .set({
          status: "closed",
          closeReason: "replaced",
          closedAt: Date.now(),
        })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();
      const closed = waitForClose(socket);
      socket.send(JSON.stringify(message));
      await expect(closed).resolves.toMatchObject({
        code: 1008,
        reason: "inactive-session",
      });
      expect(effect).not.toHaveBeenCalled();
      expect(recordActivity).not.toHaveBeenCalled();
      effect.mockClear();
      recordActivity.mockClear();
    }
  });

  it("rejects a frame sent after its session closes without applying it", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const socket = await connectDaemon(session.id, host.id);
    server.db
      .update(hostDaemonSessions)
      .set({ status: "closed", closeReason: "replaced", closedAt: Date.now() })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
    const recordActivity = vi.spyOn(server.hub, "recordDaemonActivity");
    const info = vi.spyOn(server.deps.logger, "info");

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: "daemon.restarting" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "inactive-session",
    });
    expect(server.hub.isHostRestarting(host.id)).toBe(false);
    expect(recordActivity).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedHostId: host.id,
        closeReason: "replaced",
        inactiveSessionReason: "closed",
        sessionHostId: host.id,
        sessionId: session.id,
        sessionStatus: "closed",
      }),
      "Daemon heartbeat for inactive session, closing socket",
    );
  });

  it("rejects terminal output after close before activity when there are no viewers", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const socket = await connectDaemon(session.id, host.id);
    server.db
      .update(hostDaemonSessions)
      .set({ status: "closed", closeReason: "replaced", closedAt: Date.now() })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
    let signalActivity!: () => void;
    const activityRecorded = new Promise<void>((resolve) => {
      signalActivity = resolve;
    });
    const record = server.hub.recordDaemonActivity.bind(server.hub);
    const recordActivity = vi.spyOn(server.hub, "recordDaemonActivity");
    recordActivity.mockImplementation((sessionId) => {
      signalActivity();
      record(sessionId);
    });

    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        type: "terminal.output",
        terminalId: "terminal-output-after-close",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("must not be retained").toString("base64"),
        },
      }),
    );
    const outcome = await Promise.race([
      closed.then(() => "closed" as const),
      activityRecorded.then(() => "activity" as const),
    ]);

    expect(outcome).toBe("closed");
    expect(recordActivity).not.toHaveBeenCalled();
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "inactive-session",
    });
  });

  it("rejects the old socket after a real replacement session opens", async () => {
    server = await startTestServer();
    const first = seedHostSession(server.deps);
    const oldSocket = await connectDaemon(first.session.id, first.host.id);
    const replacement = seedSession(server.deps, first.host.id, {
      instanceId: "replacement-instance",
    });
    const replacementSocket = await connectDaemon(
      replacement.id,
      first.host.id,
    );
    expect(
      getSessionById(server.db, { sessionId: first.session.id }),
    ).toMatchObject({ status: "closed", closeReason: "replaced" });
    expect(replacement.hostId).toBe(first.host.id);
    const recordActivity = vi.spyOn(server.hub, "recordDaemonActivity");

    const closed = waitForClose(oldSocket);
    oldSocket.send(JSON.stringify({ type: "daemon.restarting" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "inactive-session",
    });
    expect(server.hub.isHostRestarting(first.host.id)).toBe(false);
    expect(recordActivity).not.toHaveBeenCalled();
    expect(replacementSocket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects an accepted queued effect when a replacement session opens before drain", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const { project } = seedProjectWithSource(server.deps, { hostId: host.id });
    const environment = seedEnvironment(server.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(server.deps, {
      environmentId: environment.id,
      projectId: project.id,
    });
    const terminal = createTerminalSession(server.db, {
      cols: 120,
      daemonSessionId: session.id,
      environmentId: environment.id,
      hostId: host.id,
      initialCwd: environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: thread.id,
      title: "Terminal 1",
    });
    const oldSocket = await connectDaemon(session.id, host.id);
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    let replayFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      replayFinished = resolve;
    });
    const handleTerminalMessage =
      server.deps.terminalSessions.handleDaemonTerminalMessage.bind(
        server.deps.terminalSessions,
      );
    vi.spyOn(
      server.deps.terminalSessions,
      "handleDaemonTerminalMessage",
    ).mockImplementation((args) => {
      if (args.message.type !== "terminal.replay") {
        return handleTerminalMessage(args);
      }
      replayStarted();
      return replayGate
        .then(() => handleTerminalMessage(args))
        .finally(replayFinished);
    });
    let secondFrameAccepted!: () => void;
    const secondAccepted = new Promise<void>((resolve) => {
      secondFrameAccepted = resolve;
    });
    const recordActivity = server.hub.recordDaemonActivity.bind(server.hub);
    let activityCount = 0;
    vi.spyOn(server.hub, "recordDaemonActivity").mockImplementation(
      (sessionId) => {
        recordActivity(sessionId);
        activityCount += 1;
        if (activityCount === 2) secondFrameAccepted();
      },
    );
    const notifyEnvironment = vi.spyOn(server.hub, "notifyEnvironment");
    const info = vi.spyOn(server.deps.logger, "info");
    const chunks = Array.from({ length: 8 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(`replay-${seq}`).toString("base64"),
    }));
    const oldSocketClosed = new Promise<void>((resolve) =>
      oldSocket.once("close", () => resolve()),
    );

    try {
      oldSocket.send(
        JSON.stringify({
          type: "terminal.replay",
          requestId: "replay-before-replacement",
          terminalId: terminal.id,
          replayStartSeq: 0,
          nextSeq: chunks.length,
          chunks,
        }),
      );
      await started;
      oldSocket.send(
        JSON.stringify({
          type: "environment-change",
          environmentId: environment.id,
          change: "work-status-changed",
        }),
      );
      await secondAccepted;
      expect(
        getSessionById(server.db, { sessionId: session.id }),
      ).toMatchObject({ status: "active" });

      const replacement = seedSession(server.deps, host.id, {
        instanceId: "replacement-instance",
      });
      const replacementSocket = await connectDaemon(replacement.id, host.id);
      expect(
        getSessionById(server.db, { sessionId: session.id }),
      ).toMatchObject({ status: "closed", closeReason: "replaced" });
      releaseReplay();
      await finished;
      await vi.waitFor(() => {
        expect(
          info.mock.calls.some(
            ([fields, message]) =>
              message ===
                "Daemon heartbeat for inactive session, closing socket" &&
              typeof fields === "object" &&
              fields !== null &&
              "sessionId" in fields &&
              fields.sessionId === session.id,
          ) || notifyEnvironment.mock.calls.length > 0,
        ).toBe(true);
      });
      expect(notifyEnvironment).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({
            closeReason: "replaced",
            sessionId: session.id,
            sessionStatus: "closed",
          }),
          "Daemon heartbeat for inactive session, closing socket",
        );
      });
      await oldSocketClosed;

      expect(replacementSocket.readyState).toBe(WebSocket.OPEN);
    } finally {
      releaseReplay();
    }
  });

  it("preserves the unauthorized-session close code for a host mismatch", async () => {
    server = await startTestServer();
    const first = seedHostSession(server.deps);
    const second = seedHostSession(server.deps);
    const socket = await connectDaemon(first.session.id, first.host.id);
    const warn = vi.spyOn(server.deps.logger, "warn");
    server.db
      .update(hostDaemonSessions)
      .set({ hostId: second.host.id })
      .where(eq(hostDaemonSessions.id, first.session.id))
      .run();

    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ type: "daemon.restarting" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "unauthorized-session",
    });
    expect(server.hub.isHostRestarting(first.host.id)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: first.session.id,
        err: expect.objectContaining({
          status: 403,
          body: expect.objectContaining({ code: "invalid_request" }),
        }),
      }),
      "Daemon heartbeat for unauthorized session, closing socket",
    );
  });

  it("drains replay and its accepted follow-up exactly once after socket close", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const { project } = seedProjectWithSource(server.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(server.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(server.deps, {
      environmentId: environment.id,
      projectId: project.id,
    });
    const terminal = createTerminalSession(server.db, {
      cols: 120,
      daemonSessionId: session.id,
      environmentId: environment.id,
      hostId: host.id,
      initialCwd: environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: thread.id,
      title: "Terminal 1",
    });
    const socket = await connectDaemon(session.id, host.id);
    let acceptSecondFrame!: () => void;
    const secondFrameAccepted = new Promise<void>((resolve) => {
      acceptSecondFrame = resolve;
    });
    const recordActivity = server.hub.recordDaemonActivity.bind(server.hub);
    let activityCount = 0;
    vi.spyOn(server.hub, "recordDaemonActivity").mockImplementation(
      (sessionId) => {
        recordActivity(sessionId);
        activityCount += 1;
        if (activityCount === 2) acceptSecondFrame();
      },
    );
    let replayStarted!: () => void;
    let replayFinished!: () => void;
    const started = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      replayFinished = resolve;
    });
    const handleTerminalMessage =
      server.deps.terminalSessions.handleDaemonTerminalMessage.bind(
        server.deps.terminalSessions,
      );
    vi.spyOn(
      server.deps.terminalSessions,
      "handleDaemonTerminalMessage",
    ).mockImplementation((args) => {
      const result = handleTerminalMessage(args);
      if (args.message.type !== "terminal.replay") return result;
      replayStarted();
      return result instanceof Promise
        ? result.finally(replayFinished)
        : result;
    });
    const notifyEnvironmentOriginal = server.hub.notifyEnvironment.bind(
      server.hub,
    );
    const notifyEnvironment = vi.spyOn(server.hub, "notifyEnvironment");
    let environmentNotified!: () => void;
    const notified = new Promise<void>((resolve) => {
      environmentNotified = resolve;
    });
    notifyEnvironment.mockImplementation((...args) => {
      environmentNotified();
      return notifyEnvironmentOriginal(...args);
    });
    const chunks = Array.from({ length: 1_024 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(`replay-${seq}`).toString("base64"),
    }));
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.send(
      JSON.stringify({
        type: "terminal.replay",
        requestId: "queued-replay-before-close",
        terminalId: terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      }),
    );
    await started;
    socket.send(
      JSON.stringify({
        type: "environment-change",
        environmentId: environment.id,
        change: "work-status-changed",
      }),
    );
    await secondFrameAccepted;
    socket.close();
    await closed;
    expect(notifyEnvironment).not.toHaveBeenCalled();
    await Promise.race([
      notified,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("accepted frame did not drain")),
          5_000,
        ),
      ),
    ]);
    await finished;

    expect(notifyEnvironment).toHaveBeenCalledTimes(1);
    expect(notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "work-status-changed",
    ]);
    expect(
      getRetainedTerminalOutput(server.db, {
        hostId: host.id,
        terminalSessionId: terminal.id,
        now: Date.now(),
      })?.map(({ seq }) => seq),
    ).toEqual(chunks.map(({ seq }) => seq));
    expect(
      new Set(
        getRetainedTerminalOutput(server.db, {
          hostId: host.id,
          terminalSessionId: terminal.id,
          now: Date.now(),
        })?.map(({ seq }) => seq),
      ).size,
    ).toBe(chunks.length);
  });
});
