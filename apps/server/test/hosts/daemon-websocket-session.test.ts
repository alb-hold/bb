import { eq } from "drizzle-orm";
import {
  buildHostDaemonWebSocketProtocols,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { getSessionById, hostDaemonSessions } from "@bb/db";
import { createTestDaemonHostKey, startTestServer, type RunningTestServer } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
} from "../helpers/seed.js";

let server: RunningTestServer | null = null;
const sockets = new Set<WebSocket>();

async function connectDaemon(sessionId: string, hostId: string): Promise<WebSocket> {
  if (!server) throw new Error("test server is not running");
  const url = new URL("/internal/ws", server.baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("sessionId", sessionId);
  const socket = new WebSocket(url, buildHostDaemonWebSocketProtocols(), {
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

async function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket did not close")), 1_000);
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
        .set({ status: "closed", closeReason: "replaced", closedAt: Date.now() })
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
    socket.send(JSON.stringify({
      type: "terminal.output",
      terminalId: "terminal-output-after-close",
      chunk: {
        seq: 0,
        dataBase64: Buffer.from("must not be retained").toString("base64"),
      },
    }));
    const outcome = await Promise.race([
      closed.then(() => "closed" as const),
      activityRecorded.then(() => "activity" as const),
    ]);

    expect(outcome).toBe("closed");
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("rejects the old socket after a real replacement session opens", async () => {
    server = await startTestServer();
    const first = seedHostSession(server.deps);
    const oldSocket = await connectDaemon(first.session.id, first.host.id);
    const replacement = seedSession(server.deps, first.host.id, {
      instanceId: "replacement-instance",
    });
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

  it("applies frames accepted while active even when close happens before draining", async () => {
    server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const original = server.deps.terminalSessions.reconcileDisconnectedHostTerminals.bind(
      server.deps.terminalSessions,
    );
    let resumeOpen!: () => void;
    const waitForOpen = new Promise<void>((resolve) => {
      resumeOpen = resolve;
    });
    server.deps.terminalSessions.reconcileDisconnectedHostTerminals = async (args) => {
      await waitForOpen;
      await original(args);
    };
    const socket = await connectDaemon(session.id, host.id);

    const rejectedLog = vi.spyOn(server.deps.logger, "warn");
    const markHostRestarting = server.hub.markHostRestarting.bind(server.hub);
    let resolveRestart!: () => void;
    const hostRestarted = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });
    vi.spyOn(server.hub, "markHostRestarting").mockImplementation((hostId) => {
      markHostRestarting(hostId);
      if (hostId === host.id) resolveRestart();
    });
    socket.send(JSON.stringify({
      type: "terminal.output",
      terminalId: "terminal-without-clients",
      chunk: { seq: 0, dataBase64: Buffer.from("queued").toString("base64") },
    }));
    socket.send(JSON.stringify({ type: "daemon.restarting" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    resumeOpen();
    await hostRestarted;

    expect(server.hub.isHostRestarting(host.id)).toBe(true);
    expect(rejectedLog).not.toHaveBeenCalledWith(
      expect.anything(),
      "Daemon message rejected, closing socket",
    );
  });
});
