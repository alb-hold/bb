import { replaceMachineEnvironment } from "../../src/services/machines/environment-settings.js";
import * as gitCredentials from "../../src/services/machines/git-credentials.js";
import {
  appendRetainedTerminalOutputChunks,
  createConnection,
  closeSession,
  createTerminalSession,
  getAppSettings,
  getRetainedTerminalOutput,
  getThread,
  getTerminalSession,
  listTerminalSessions,
  setAppSettings,
  updateHost,
  updateTerminalSession,
  updateTerminalSessions,
} from "@bb/db";
import {
  TERMINAL_DATA_MAX_BYTES,
  type EnvironmentStatus,
  type TerminalSessionCloseReason,
} from "@bb/domain";
import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  apiErrorSchema,
  terminalListResponseSchema,
  terminalServerMessageSchema,
  terminalOutputResponseSchema,
  terminalScreenResponseSchema,
  type TerminalServerMessage,
  terminalSessionSchema,
} from "@bb/server-contract";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  expireArchiveUndoGrace,
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import {
  handleDaemonSocketClosed,
  handleHostSessionOpened,
} from "../../src/internal/session-owner-side-effects.js";
import {
  onDaemonSocketClose,
  onDaemonSocketMessage,
  onDaemonSocketOpen,
} from "../../src/ws/daemon-protocol.js";
import {
  onTerminalSocketClose,
  onTerminalSocketMessage,
  onTerminalSocketOpen,
} from "../../src/ws/terminal-protocol.js";
import { TERMINAL_CLIENT_STALE_MS } from "../../src/ws/hub.js";
import { TERMINAL_SCREEN_MAX_IN_FLIGHT_READS } from "../../src/services/terminals/terminal-screen.js";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface FakeBrowserSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface TerminalRouteFixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  host: ReturnType<typeof seedHost>;
  session: ReturnType<typeof seedHostSession>["session"];
  socket: FakeDaemonSocket;
  thread: ReturnType<typeof seedThread>;
}

type TestDb = TestAppHarness["db"];

function retainedAfterFlush(
  terminalSessions: { flushAllRetainedOutput(): void },
  ...args: Parameters<typeof getRetainedTerminalOutput>
): ReturnType<typeof getRetainedTerminalOutput> {
  terminalSessions.flushAllRetainedOutput();
  return getRetainedTerminalOutput(...args);
}

function getTerminalSessionForThread(
  db: TestDb,
  args: { terminalId: string; threadId: string },
) {
  return getTerminalSession(db, {
    kind: "terminal",
    terminalId: args.terminalId,
  });
}

function getThreadlessTerminalSessionForEnvironment(
  db: TestDb,
  args: { environmentId: string; terminalId: string },
) {
  return getTerminalSession(db, {
    kind: "terminal",
    terminalId: args.terminalId,
  });
}

function listTerminalSessionsByThread(db: TestDb, threadId: string) {
  return listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: false,
  });
}

function markTerminalSessionExited(
  db: TestDb,
  args: {
    closeReason: TerminalSessionCloseReason;
    exitCode: number | null;
    terminalId: string;
  },
) {
  return updateTerminalSession(db, {
    scope: { kind: "terminal", terminalId: args.terminalId },
    update: {
      closeReason: args.closeReason,
      exitCode: args.exitCode,
      kind: "exit",
    },
  });
}

function seedExitedTerminalSession(
  fixture: TerminalRouteFixture,
  args: { daemonSessionId: string },
) {
  const session = createTerminalSession(fixture.harness.db, {
    cols: 120,
    daemonSessionId: args.daemonSessionId,
    environmentId: fixture.environment.id,
    hostId: fixture.host.id,
    initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
    rows: 32,
    status: "running",
    threadId: fixture.thread.id,
    title: "Terminal 1",
  });
  markTerminalSessionExited(fixture.harness.db, {
    closeReason: "process-exit",
    exitCode: 1,
    terminalId: session.id,
  });
  return session;
}

function markTerminalSessionUserInput(
  db: TestDb,
  args: { now: number; terminalId: string; threadId: string },
) {
  return updateTerminalSession(db, {
    now: args.now,
    scope: { kind: "terminal", terminalId: args.terminalId },
    update: { kind: "user-input" },
  });
}

function markTerminalSessionsExited(
  db: TestDb,
  scope: Parameters<typeof updateTerminalSessions>[1]["scope"],
  closeReason: TerminalSessionCloseReason,
) {
  return updateTerminalSessions(db, {
    scope: { ...scope, statuses: ["starting", "running", "disconnected"] },
    update: { closeReason, kind: "exit" },
  });
}

function markThreadTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: TerminalSessionCloseReason; threadId: string },
) {
  return markTerminalSessionsExited(
    db,
    { kind: "thread", threadId: args.threadId },
    args.closeReason,
  );
}

function markEnvironmentTerminalSessionsExited(
  db: TestDb,
  args: { closeReason: TerminalSessionCloseReason; environmentId: string },
) {
  return markTerminalSessionsExited(
    db,
    { environmentId: args.environmentId, kind: "environment" },
    args.closeReason,
  );
}

function markDaemonTerminalSessionsDisconnected(
  db: TestDb,
  args: { daemonSessionId: string },
) {
  return updateTerminalSessions(db, {
    scope: {
      daemonSessionId: args.daemonSessionId,
      kind: "daemon",
      statuses: ["starting", "running"],
    },
    update: { kind: "disconnect", retainDaemonSession: false },
  });
}

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

interface PendingTerminalOpen {
  openMessage: TerminalOpenMessage;
  responsePromise: Promise<Response>;
}

interface CreateTerminalRouteFixtureArgs {
  environmentStatus?: EnvironmentStatus;
  terminalCloseTimeoutMs?: number;
  terminalOpenTimeoutMs?: number;
}

interface StandaloneTerminalOpenArgs {
  cwd: string | null;
  hostId?: string;
}

function createFakeDaemonSocket(): FakeDaemonSocket {
  const sentMessages: string[] = [];
  const closeSocket: FakeDaemonSocket["close"] = () => {};
  const sendSocketMessage: FakeDaemonSocket["send"] = (data) => {
    sentMessages.push(data);
  };
  return {
    close: vi.fn(closeSocket),
    send: vi.fn(sendSocketMessage),
    sentMessages,
  };
}

function createFakeBrowserSocket(): FakeBrowserSocket {
  const sentMessages: string[] = [];
  const closeSocket: FakeBrowserSocket["close"] = () => {};
  const sendSocketMessage: FakeBrowserSocket["send"] = (data) => {
    sentMessages.push(data);
  };
  return {
    close: vi.fn(closeSocket),
    send: vi.fn(sendSocketMessage),
    sentMessages,
  };
}

function readBrowserMessages(
  socket: FakeBrowserSocket,
): TerminalServerMessage[] {
  return socket.sentMessages.map((message) =>
    terminalServerMessageSchema.parse(JSON.parse(message)),
  );
}

function readDaemonOperationMessages(
  socket: FakeDaemonSocket,
): HostDaemonServerWsMessage[] {
  return socket.sentMessages
    .map((message) =>
      hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
    )
    .filter((message) => message.type !== "machine-environment.replace");
}

async function waitForDaemonMessage(
  socket: FakeDaemonSocket,
  messageIndex = 0,
): Promise<HostDaemonServerWsMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const message = readDaemonOperationMessages(socket)[messageIndex];
    if (message !== undefined) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for daemon message");
}

async function createTerminalRouteFixture(
  args: CreateTerminalRouteFixtureArgs = {},
): Promise<TerminalRouteFixture> {
  const harness = await createTestAppHarness({
    ...(args.terminalCloseTimeoutMs === undefined
      ? {}
      : { terminalCloseTimeoutMs: args.terminalCloseTimeoutMs }),
    ...(args.terminalOpenTimeoutMs === undefined
      ? {}
      : { terminalOpenTimeoutMs: args.terminalOpenTimeoutMs }),
  });
  const seeded = seedHostSession(harness.deps, { id: "terminal-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/terminal-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/terminal-workspace",
    projectId: project.id,
    status: args.environmentStatus ?? "ready",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  const socket = createFakeDaemonSocket();
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);
  return {
    environment,
    harness,
    host: seeded.host,
    session: seeded.session,
    socket,
    thread,
  };
}

async function startPendingTerminalOpen(
  fixture: TerminalRouteFixture,
  cwd?: string,
): Promise<PendingTerminalOpen> {
  const responsePromise = Promise.resolve(
    fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        ...(cwd === undefined ? {} : { cwd }),
        target: { kind: "thread", threadId: fixture.thread.id },
      }),
    }),
  );
  const openMessage = await waitForDaemonMessage(fixture.socket);
  if (openMessage.type !== "terminal.open") {
    throw new Error(`Expected terminal.open, received ${openMessage.type}`);
  }
  return {
    openMessage,
    responsePromise,
  };
}

async function startPendingEnvironmentTerminalOpen(
  fixture: TerminalRouteFixture,
): Promise<PendingTerminalOpen> {
  const responsePromise = Promise.resolve(
    fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        target: {
          kind: "environment",
          environmentId: fixture.environment.id,
        },
      }),
    }),
  );
  const openMessage = await waitForDaemonMessage(fixture.socket);
  if (openMessage.type !== "terminal.open") {
    throw new Error(`Expected terminal.open, received ${openMessage.type}`);
  }
  return {
    openMessage,
    responsePromise,
  };
}

async function startPendingStandaloneTerminalOpen(
  fixture: TerminalRouteFixture,
  args: StandaloneTerminalOpenArgs = {
    cwd: "/tmp/standalone-terminal",
  },
): Promise<PendingTerminalOpen> {
  const responsePromise = Promise.resolve(
    fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        target: {
          kind: "host_path",
          hostId: args.hostId ?? fixture.host.id,
          cwd: args.cwd,
        },
      }),
    }),
  );
  const openMessage = await waitForDaemonMessage(fixture.socket);
  if (openMessage.type !== "terminal.open") {
    throw new Error(`Expected terminal.open, received ${openMessage.type}`);
  }
  return {
    openMessage,
    responsePromise,
  };
}

function acknowledgeTerminalOpen(
  fixture: TerminalRouteFixture,
  openMessage: TerminalOpenMessage,
  initialCwd = "/tmp/terminal-workspace",
): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.host.id,
    sessionId: fixture.session.id,
    message: {
      type: "terminal.opened",
      requestId: openMessage.requestId,
      terminalId: openMessage.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd,
      cols: 100,
      rows: 30,
    },
  });
}

describe("public terminal routes", () => {
  let harnesses: TestAppHarness[] = [];

  beforeEach(() => {
    harnesses = [];
  });

  afterEach(async () => {
    for (const harness of harnesses) {
      await harness.cleanup();
    }
  });

  it("uses global variables everywhere while forwarding automatic credentials only to secondary hosts", async () => {
    const resolve = vi
      .spyOn(gitCredentials, "resolveGitCredentials")
      .mockResolvedValue([
        {
          name: "GH_TOKEN",
          value: "terminal-secret",
          source: { core: "machine-git" },
          reason: "Server gh login",
        },
      ]);
    try {
      for (const primary of [true, false]) {
        const fixture = await createTerminalRouteFixture();
        harnesses.push(fixture.harness);
        setAppSettings(fixture.harness.db, {
          ...getAppSettings(fixture.harness.db),
          machineGitCredentialsEnabled: true,
        });
        if (primary) seedPrimaryHost(fixture.harness.deps, fixture.host.id);
        else {
          const primaryHost = seedHost(fixture.harness.deps, {
            id: `primary-${fixture.host.id}`,
          });
          seedPrimaryHost(fixture.harness.deps, primaryHost.id);
        }
        await replaceMachineEnvironment(
          fixture.harness.db,
          fixture.harness.config.dataDir,
          {
            variables: [
              { name: "CUSTOM_TERMINAL", value: "terminal-value", note: null },
            ],
          },
        );
        const pending = await startPendingTerminalOpen(fixture);
        expect(pending.openMessage.contributedEnv).toEqual([
          ...(!primary ? await resolve() : []),
          expect.objectContaining({
            name: "CUSTOM_TERMINAL",
            value: "terminal-value",
          }),
        ]);
        acknowledgeTerminalOpen(fixture, pending.openMessage);
        expect((await pending.responsePromise).status).toBe(201);
        expect(
          JSON.stringify(
            listTerminalSessions(fixture.harness.db, {
              scope: { threadId: fixture.thread.id, kind: "thread" },
              visible: true,
            }),
          ),
        ).not.toContain("terminal-secret");
      }
    } finally {
      resolve.mockRestore();
    }
  });

  it("lists terminal sessions for a thread", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const exited = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 2",
    });
    markTerminalSessionExited(fixture.harness.db, {
      terminalId: exited.id,
      exitCode: 0,
      closeReason: "user",
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`,
    );

    expect(response.status).toBe(200);
    const body = terminalListResponseSchema.parse(await readJson(response));
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: stored.id,
        status: "running",
        title: "Terminal 1",
      }),
    ]);
  });

  it("keeps a retained exited terminal listed until a tab close dismisses it", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Retained tab",
    });
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("retained tab output\n").toString("base64"),
        },
      },
    });
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const listUrl = `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`;
    const listed = terminalListResponseSchema.parse(
      await readJson(await fixture.harness.app.request(listUrl)),
    );
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({ id: session.id, status: "exited" }),
    );

    const closeResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );
    expect(closeResponse.status).toBe(200);

    const afterClose = terminalListResponseSchema.parse(
      await readJson(await fixture.harness.app.request(listUrl)),
    );
    expect(afterClose.sessions).not.toContainEqual(
      expect.objectContaining({ id: session.id }),
    );
  });

  it("keeps a dismissed terminal hidden until its retained output expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-17T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    try {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);
      const session = createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title: "Long retained output",
      });
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: session.id,
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("retained until expiry\n").toString(
              "base64",
            ),
          },
        },
      });
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: session.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });

      const outputExpiresAt = now + 60 * 60_000;
      fixture.harness.db.$client
        .prepare(
          "UPDATE fork_terminal_output SET expires_at = ? WHERE terminal_session_id = ? AND host_id = ?",
        )
        .run(outputExpiresAt, session.id, fixture.host.id);
      const closeResponse = await fixture.harness.app.request(
        `/api/v1/terminals/${session.id}/close`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "force", reason: "user" }),
        },
      );
      expect(closeResponse.status).toBe(200);

      const listUrl = `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`;
      const listIds = async () => {
        const response = await fixture.harness.app.request(listUrl);
        expect(response.status).toBe(200);
        return terminalListResponseSchema
          .parse(await readJson(response))
          .sessions.map(({ id }) => id);
      };
      expect(await listIds()).not.toContain(session.id);

      vi.setSystemTime(now + 31 * 60_000);
      expect(await listIds()).not.toContain(session.id);

      vi.setSystemTime(outputExpiresAt + 1);
      expect(await listIds()).not.toContain(session.id);

      const dismissal = fixture.harness.db.$client
        .prepare(
          `SELECT expires_at AS expiresAt FROM fork_terminal_tab_dismissals
           WHERE terminal_session_id = ? AND host_id = ?`,
        )
        .get(session.id, fixture.host.id) as { expiresAt: number } | undefined;
      expect(dismissal?.expiresAt).toBe(outputExpiresAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records daemon attention on the existing thread unread timestamp and clears terminal state when visible", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal attention",
    });
    onDaemonSocketMessage(fixture.harness.deps, {
      hostId: fixture.host.id,
      raw: JSON.stringify({
        type: "terminal.attention",
        terminalId: stored.id,
        seq: 7,
        kind: "osc-777",
        title: "Build",
        body: "Finished",
      }),
      sessionId: fixture.session.id,
      socket: fixture.socket,
    });
    const latestAttentionAt = getThread(
      fixture.harness.db,
      fixture.thread.id,
    )?.latestAttentionAt;
    expect(latestAttentionAt).toBeGreaterThan(fixture.thread.latestAttentionAt);
    const visible = await fixture.harness.app.request(
      `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`,
    );
    const listed = terminalListResponseSchema.parse(await readJson(visible));
    expect(listed.sessions[0]?.attention).toEqual({
      at: latestAttentionAt,
      body: "Finished",
      kind: "osc-777",
      seq: 7,
      title: "Build",
    });
    const browserSocket = createFakeBrowserSocket();
    onTerminalSocketOpen(fixture.harness.deps, {
      outputAcks: true,
      resizeAcks: false,
      sinceSeq: 0,
      socket: browserSocket,
      terminalId: stored.id,
    });
    onTerminalSocketMessage(fixture.harness.deps, {
      raw: JSON.stringify({ type: "visibility", visible: true }),
      socket: browserSocket,
      terminalId: stored.id,
    });
    const afterClear = terminalListResponseSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`,
        ),
      ),
    );
    expect(afterClear.sessions[0]?.attention).toBeNull();
  });

  it("gets and renames a terminal by ID without a redundant scope", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 30,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const getResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}`,
    );
    expect(getResponse.status).toBe(200);
    expect(
      terminalSessionSchema.parse(await readJson(getResponse)),
    ).toMatchObject({
      id: stored.id,
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const renameResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Dev server" }),
      },
    );
    expect(renameResponse.status).toBe(200);
    expect(
      terminalSessionSchema.parse(await readJson(renameResponse)),
    ).toMatchObject({
      id: stored.id,
      title: "Dev server",
    });
  });

  it.each([
    ["no scope", "/api/v1/terminals"],
    ["dual scope", "/api/v1/terminals?threadId=thr_one&environmentId=env_two"],
    ["cwd outside host scope", "/api/v1/terminals?threadId=thr_one&cwd=%2Ftmp"],
  ])("rejects terminal list requests with %s", async (_label, path) => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);

    const response = await harness.app.request(path);

    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects an unknown explicit terminal host instead of falling back", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const response = await fixture.harness.app.request(
      "/api/v1/terminals?hostId=host_wrong",
    );

    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "host_not_found",
    });
  });

  it("creates and lists threadless terminal sessions for an environment", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const pending = await startPendingEnvironmentTerminalOpen(fixture);

    expect(pending.openMessage).not.toHaveProperty("threadId");
    expect(pending.openMessage.target).toMatchObject({
      kind: "workspace",
      environmentId: fixture.environment.id,
      workspaceContext: {
        workspacePath: "/tmp/terminal-workspace",
      },
    });
    acknowledgeTerminalOpen(fixture, pending.openMessage);
    const response = await pending.responsePromise;

    expect(response.status).toBe(201);
    const created = terminalSessionSchema.parse(await readJson(response));
    expect(created).toMatchObject({
      environmentId: fixture.environment.id,
      threadId: null,
      status: "running",
      title: "zsh",
    });

    const environmentListResponse = await fixture.harness.app.request(
      `/api/v1/terminals?environmentId=${encodeURIComponent(
        fixture.environment.id,
      )}`,
    );
    expect(environmentListResponse.status).toBe(200);
    const environmentList = terminalListResponseSchema.parse(
      await readJson(environmentListResponse),
    );
    expect(environmentList.sessions).toEqual([
      expect.objectContaining({
        id: created.id,
        threadId: null,
      }),
    ]);

    const threadListResponse = await fixture.harness.app.request(
      `/api/v1/terminals?threadId=${encodeURIComponent(fixture.thread.id)}`,
    );
    const threadList = terminalListResponseSchema.parse(
      await readJson(threadListResponse),
    );
    expect(threadList.sessions).toEqual([]);
  });

  it("creates and lists terminal sessions for a host path without an environment", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const pending = await startPendingStandaloneTerminalOpen(fixture);

    expect(pending.openMessage).not.toHaveProperty("threadId");
    expect(pending.openMessage.target).toEqual({
      kind: "host_path",
      cwd: "/tmp/standalone-terminal",
    });
    acknowledgeTerminalOpen(
      fixture,
      pending.openMessage,
      "/tmp/standalone-terminal",
    );
    const response = await pending.responsePromise;

    expect(response.status).toBe(201);
    const created = terminalSessionSchema.parse(await readJson(response));
    expect(created).toMatchObject({
      environmentId: null,
      hostId: fixture.host.id,
      initialCwd: "/tmp/standalone-terminal",
      threadId: null,
      status: "running",
    });

    const listResponse = await fixture.harness.app.request(
      `/api/v1/terminals?hostId=${encodeURIComponent(
        fixture.host.id,
      )}&cwd=${encodeURIComponent("/tmp/standalone-terminal")}`,
    );
    expect(listResponse.status).toBe(200);
    const list = terminalListResponseSchema.parse(await readJson(listResponse));
    expect(list.sessions).toEqual([
      expect.objectContaining({
        id: created.id,
        environmentId: null,
        threadId: null,
      }),
    ]);
  });

  it("allows the same public API caller to open a host path and a workspace cwd", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const hostPath = await startPendingStandaloneTerminalOpen(fixture, {
      cwd: "/tmp",
    });
    expect(hostPath.openMessage.target).toEqual({
      kind: "host_path",
      cwd: "/tmp",
    });
    acknowledgeTerminalOpen(fixture, hostPath.openMessage, "/tmp");
    const hostPathResponse = await hostPath.responsePromise;
    expect(hostPathResponse.status).toBe(201);
    expect(
      terminalSessionSchema.parse(await readJson(hostPathResponse)),
    ).toMatchObject({ initialCwd: "/tmp", hostId: fixture.host.id });
    fixture.socket.sentMessages.length = 0;

    const workspace = await startPendingTerminalOpen(fixture, "/tmp");
    expect(workspace.openMessage.cwd).toBe("/tmp");
    expect(workspace.openMessage.target).toMatchObject({ kind: "workspace" });
    acknowledgeTerminalOpen(fixture, workspace.openMessage, "/tmp");
    const workspaceResponse = await workspace.responsePromise;
    expect(workspaceResponse.status).toBe(201);
    expect(
      terminalSessionSchema.parse(await readJson(workspaceResponse)),
    ).toMatchObject({ initialCwd: "/tmp", hostId: fixture.host.id });
  });

  it("does not allow cwd overrides when the target host cannot open host paths", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    updateHost(fixture.harness.db, fixture.harness.hub, fixture.host.id, {
      destroyedAt: Date.now(),
    });

    const hostPathResponse = await fixture.harness.app.request(
      "/api/v1/terminals",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({
          cols: 100,
          rows: 30,
          target: {
            kind: "host_path",
            hostId: fixture.host.id,
            cwd: "/tmp",
          },
        }),
      },
    );
    expect(hostPathResponse.status).toBe(404);

    const workspaceResponsePromise = fixture.harness.app.request(
      "/api/v1/terminals",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({
          cols: 100,
          rows: 30,
          cwd: "/tmp",
          target: { kind: "thread", threadId: fixture.thread.id },
        }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const workspaceOpen = readDaemonOperationMessages(fixture.socket).find(
      (message) => message.type === "terminal.open",
    );
    if (workspaceOpen?.type === "terminal.open") {
      acknowledgeTerminalOpen(fixture, workspaceOpen, "/tmp");
    }
    const workspaceResponse = await workspaceResponsePromise;
    expect(workspaceResponse.status).toBe(404);
    expect(
      apiErrorSchema.parse(await readJson(workspaceResponse)),
    ).toMatchObject({ code: "host_unavailable" });
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
  });

  it.each([
    ["relative", "tmp"],
    ["parent traversal", "/tmp/../tmp"],
    ["NUL", "/tmp\u0000invalid"],
    ["file", "/etc/passwd"],
    ["missing", "/tmp/p19-public-terminal-missing-cwd"],
  ])(
    "stores the workspace default reported after the daemon rejects %s cwd",
    async (_label, cwd) => {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);

      const pending = await startPendingTerminalOpen(fixture, cwd);
      expect(pending.openMessage.cwd).toBe(cwd);
      acknowledgeTerminalOpen(
        fixture,
        pending.openMessage,
        "/tmp/terminal-workspace",
      );
      const response = await pending.responsePromise;
      expect(response.status).toBe(201);
      expect(
        terminalSessionSchema.parse(await readJson(response)),
      ).toMatchObject({ initialCwd: "/tmp/terminal-workspace" });
    },
  );

  it("rejects an over-long cwd before creating a terminal", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const response = await fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        cwd: `/${"a".repeat(4096)}`,
        target: { kind: "thread", threadId: fixture.thread.id },
      }),
    });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "invalid_request",
    });
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
  });

  it("creates a host terminal without an environment or cwd", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const responsePromise = Promise.resolve(
      fixture.harness.app.request("/api/v1/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cols: 100,
          rows: 30,
          target: {
            kind: "host_path",
            hostId: fixture.host.id,
            cwd: null,
          },
        }),
      }),
    );
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }
    expect(openMessage).not.toHaveProperty("threadId");
    expect(openMessage.target).toEqual({
      kind: "host_path",
      cwd: null,
    });
    expect(openMessage).not.toHaveProperty("cwd");
    acknowledgeTerminalOpen(fixture, openMessage, "/home/bb");

    const response = await responsePromise;
    expect(response.status).toBe(201);
    expect(terminalSessionSchema.parse(await readJson(response))).toMatchObject(
      {
        environmentId: null,
        hostId: fixture.host.id,
        initialCwd: "/home/bb",
        threadId: null,
        status: "running",
      },
    );
  });

  it("forwards an explicitly requested cwd to the daemon", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const pending = await startPendingTerminalOpen(fixture, "/tmp/split");
    expect(pending.openMessage.cwd).toBe("/tmp/split");
    acknowledgeTerminalOpen(fixture, pending.openMessage, "/tmp/split");
    const response = await pending.responsePromise;
    expect(response.status).toBe(201);
    expect(terminalSessionSchema.parse(await readJson(response))).toMatchObject(
      {
        initialCwd: "/tmp/split",
      },
    );
  });

  it("keeps a non-empty cwd for a host home terminal disconnected before open", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const responsePromise = Promise.resolve(
      fixture.harness.app.request("/api/v1/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cols: 100,
          rows: 30,
          target: {
            kind: "host_path",
            hostId: fixture.host.id,
            cwd: null,
          },
        }),
      }),
    );
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }

    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.session.id,
    });

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "host_disconnected",
    });

    const listResponse = await fixture.harness.app.request(
      `/api/v1/terminals?hostId=${encodeURIComponent(fixture.host.id)}`,
    );
    expect(listResponse.status).toBe(200);
    const list = terminalListResponseSchema.parse(await readJson(listResponse));
    expect(list.sessions).toEqual([
      expect.objectContaining({
        id: openMessage.terminalId,
        environmentId: null,
        initialCwd: "~",
        status: "disconnected",
        threadId: null,
      }),
    ]);
  });

  it("attaches browser sockets to threadless terminal sessions", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: null,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();

    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      socket: browserSocket,
      sinceSeq: 0,
      terminalId: stored.id,
    });
    const attachMessage = await waitForDaemonMessage(fixture.socket);
    expect(attachMessage).toMatchObject({
      type: "terminal.attach",
      terminalId: stored.id,
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });
    if (attachMessage.type !== "terminal.attach") {
      throw new Error(
        `Expected terminal.attach, received ${attachMessage.type}`,
      );
    }

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: attachMessage.requestId,
        terminalId: stored.id,
        chunks: [],
        replayStartSeq: 0,
        nextSeq: 0,
      },
    });
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "attached",
        session: expect.objectContaining({
          id: stored.id,
          threadId: null,
        }),
      }),
    );

    fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
      socket: browserSocket,
      terminalId: stored.id,
      message: {
        type: "input",
        dataBase64: Buffer.from("pwd\n").toString("base64"),
      },
    });
    const inputMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(inputMessage).toMatchObject({
      type: "terminal.input",
      terminalId: stored.id,
    });
    expect(
      getThreadlessTerminalSessionForEnvironment(fixture.harness.db, {
        environmentId: fixture.environment.id,
        terminalId: stored.id,
      }),
    ).toMatchObject({
      lastUserInputAt: expect.any(Number),
    });
  });

  it("rejects terminal creation when the thread has no environment", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const host = seedHost(harness.deps, { id: "terminal-no-env-host" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/terminal-no-env-project",
    });
    const thread = seedThread(harness.deps, {
      environmentId: null,
      projectId: project.id,
      status: "idle",
    });

    const response = await harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cols: 80,
        rows: 24,
        target: { kind: "thread", threadId: thread.id },
      }),
    });

    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "thread_environment_unavailable",
      details: {
        reason: "never_attached",
        environmentStatus: null,
      },
    });
  });

  it("opens a terminal after the daemon acknowledges the PTY", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const responsePromise = fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        target: { kind: "thread", threadId: fixture.thread.id },
      }),
    });
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }
    expect(openMessage).toMatchObject({
      cols: 100,
      rows: 30,
      threadId: fixture.thread.id,
      target: {
        kind: "workspace",
        environmentId: fixture.environment.id,
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
    });

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.opened",
        requestId: openMessage.requestId,
        terminalId: openMessage.terminalId,
        shell: "/bin/zsh",
        title: "zsh",
        initialCwd: "/tmp/terminal-workspace",
        cols: 100,
        rows: 30,
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(201);
    const body = terminalSessionSchema.parse(await readJson(response));
    expect(body).toMatchObject({
      initialCwd: "/tmp/terminal-workspace",
      status: "running",
      title: "zsh",
    });
  });

  it("opens a command terminal with thread context for the daemon", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const responsePromise = fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        start: { mode: "command", command: "pnpm dev" },
        target: { kind: "thread", threadId: fixture.thread.id },
      }),
    });
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }
    expect(openMessage).toMatchObject({
      threadId: fixture.thread.id,
      start: { mode: "command", command: "pnpm dev" },
      target: {
        kind: "workspace",
        environmentId: fixture.environment.id,
        workspaceContext: {
          workspacePath: "/tmp/terminal-workspace",
        },
      },
    });

    acknowledgeTerminalOpen(fixture, openMessage);
    const response = await responsePromise;
    expect(response.status).toBe(201);
  });

  it("sends input to a running terminal over the daemon session", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const notify = vi.spyOn(
      fixture.harness.pluginService.events,
      "emitTerminalInput",
    );
    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dataBase64: Buffer.from("echo hi\n", "utf8").toString("base64"),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      id: session.id,
      hostId: fixture.host.id,
    });
    expect(notify.mock.calls[0]?.[0]).not.toHaveProperty("dataBase64");
    const inputMessage = await waitForDaemonMessage(fixture.socket);
    expect(inputMessage).toMatchObject({
      type: "terminal.input",
      terminalId: session.id,
      dataBase64: Buffer.from("echo hi\n", "utf8").toString("base64"),
    });
    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        threadId: fixture.thread.id,
        terminalId: session.id,
      })?.lastUserInputAt,
    ).not.toBeNull();
  });

  it("rejects oversized public terminal input before forwarding it", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dataBase64: Buffer.alloc(TERMINAL_DATA_MAX_BYTES + 1).toString(
            "base64",
          ),
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
  });

  it.each(["route", "websocket"] as const)(
    "writes the first-input marker once and not again on later %s input",
    async (path) => {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);
      const session = createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title: "Terminal 1",
      });
      const browserSocket = createFakeBrowserSocket();
      fixture.harness.hub.registerTerminalClient(session.id, browserSocket);
      const sqlite = fixture.harness.db.$client;
      const prepare = sqlite.prepare.bind(sqlite);
      const statements: string[] = [];
      vi.spyOn(sqlite, "prepare").mockImplementation((source: string) => {
        statements.push(source);
        return prepare(source);
      });
      const sendInput = async (text: string) => {
        const dataBase64 = Buffer.from(text, "utf8").toString("base64");
        if (path === "route") {
          const response = await fixture.harness.app.request(
            `/api/v1/terminals/${session.id}/input`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ dataBase64 }),
            },
          );
          expect(response.status).toBe(200);
          return;
        }
        fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
          terminalId: session.id,
          socket: browserSocket,
          message: { type: "input", dataBase64 },
        });
      };
      const terminalWrites = () =>
        statements.filter((source) =>
          /^\s*update\s+["`]?terminal_sessions["`]?/iu.test(source),
        ).length;

      await sendInput("a");
      expect(terminalWrites()).toBe(1);
      const firstMarker = getTerminalSessionForThread(fixture.harness.db, {
        threadId: fixture.thread.id,
        terminalId: session.id,
      })?.lastUserInputAt;
      expect(firstMarker).toBeTypeOf("number");

      await sendInput("b");
      await sendInput("c");
      expect(terminalWrites()).toBe(1);
      expect(
        getTerminalSessionForThread(fixture.harness.db, {
          threadId: fixture.thread.id,
          terminalId: session.id,
        })?.lastUserInputAt,
      ).toBe(firstMarker);
      const inputs = readDaemonOperationMessages(fixture.socket).filter(
        (message) => message.type === "terminal.input",
      );
      expect(inputs).toHaveLength(3);
    },
  );

  it("resizes a running terminal over the daemon session", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/resize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 140, rows: 40 }),
      },
    );

    expect(response.status).toBe(200);
    expect(terminalSessionSchema.parse(await readJson(response))).toEqual(
      expect.objectContaining({
        id: session.id,
        cols: 140,
        rows: 40,
      }),
    );
    const resizeMessage = await waitForDaemonMessage(fixture.socket);
    expect(resizeMessage).toMatchObject({
      type: "terminal.resize",
      terminalId: session.id,
      cols: 140,
      rows: 40,
    });
  });

  it("reads output by requesting daemon replay", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const responsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output?sinceSeq=2&limitChunks=1&tailBytes=3`,
    );
    const attachMessage = await waitForDaemonMessage(fixture.socket);
    if (attachMessage.type !== "terminal.attach") {
      throw new Error(
        `Expected terminal.attach, received ${attachMessage.type}`,
      );
    }
    expect(attachMessage).toMatchObject({
      terminalId: session.id,
      sinceSeq: 2,
      tailBytes: 3,
    });

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: attachMessage.requestId,
        terminalId: session.id,
        chunks: [
          {
            seq: 2,
            dataBase64: Buffer.from("old", "utf8").toString("base64"),
          },
          {
            seq: 3,
            dataBase64: Buffer.from("new", "utf8").toString("base64"),
          },
        ],
        replayStartSeq: 2,
        nextSeq: 4,
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(
      terminalOutputResponseSchema.parse(await readJson(response)),
    ).toEqual({
      chunks: [
        {
          seq: 3,
          dataBase64: Buffer.from("new", "utf8").toString("base64"),
        },
      ],
      nextSeq: 4,
      truncated: true,
      status: "running",
      exitCode: null,
      closeReason: null,
    });
  });

  it("reads retained output for an exited terminal", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(
            "setup failed\nbuild failed\n",
            "utf8",
          ).toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 1,
        closeReason: "process-exit",
      },
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );

    expect(response.status).toBe(200);
    expect(
      terminalOutputResponseSchema.parse(await readJson(response)),
    ).toEqual({
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from(
            "setup failed\nbuild failed\n",
            "utf8",
          ).toString("base64"),
        },
      ],
      nextSeq: 1,
      truncated: false,
      status: "exited",
      exitCode: 1,
      closeReason: "process-exit",
    });
    const linesResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output?lines=1`,
    );
    expect(linesResponse.status).toBe(200);
    expect(
      terminalOutputResponseSchema.parse(await readJson(linesResponse)).chunks,
    ).toEqual([
      {
        seq: 0,
        dataBase64: Buffer.from("build failed\n", "utf8").toString("base64"),
      },
    ]);
    const screenResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/screen?lines=2`,
    );
    expect(screenResponse.status).toBe(200);
    expect(
      terminalScreenResponseSchema.parse(await readJson(screenResponse)),
    ).toMatchObject({
      rows: ["setup failed", "            build failed"],
      cols: 120,
      gridRows: 32,
      truncated: false,
    });
  });

  it("returns 404 without rows for an unknown terminal screen ID", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);

    const response = await fixture.harness.app.request(
      "/api/v1/terminals/unknown-terminal/screen",
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("rows");
    expect(apiErrorSchema.parse(JSON.parse(body)).code).toBe(
      "terminal_not_found",
    );
  });

  it("returns a retryable queue-full response while in-flight screens complete", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Queue capacity",
    });
    const retainedOutput = `${"screen line for queue capacity\n".repeat(300)}`;
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(retainedOutput).toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const reads = Array.from(
      { length: TERMINAL_SCREEN_MAX_IN_FLIGHT_READS },
      () =>
        fixture.harness.app.request(`/api/v1/terminals/${session.id}/screen`),
    );
    const overflow = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/screen`,
    );
    const overflowBody = apiErrorSchema.parse(await readJson(overflow));
    const responses = await Promise.all(reads);

    expect(overflow.status).toBe(503);
    expect(overflowBody).toMatchObject({
      code: "terminal_screen_queue_full",
      message: `Terminal screen read queue is full (maximum ${TERMINAL_SCREEN_MAX_IN_FLIGHT_READS} in flight)`,
      retryable: true,
    });
    expect(responses).toHaveLength(TERMINAL_SCREEN_MAX_IN_FLIGHT_READS);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(
        terminalScreenResponseSchema
          .parse(await readJson(response))
          .rows.join("\n"),
      ).toContain("queue capacity");
    }
  });

  it("retries screen reads rejected by the bounded queue through the SDK", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "SDK queue capacity",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(
            `${"screen line for SDK queue capacity\n".repeat(300)}`,
          ).toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://localhost",
        runtime: "node",
        fetch: async (input, init) =>
          fixture.harness.app.fetch(new Request(input, init)),
      }),
    });

    const screens = await Promise.all(
      Array.from({ length: TERMINAL_SCREEN_MAX_IN_FLIGHT_READS + 1 }, () =>
        sdk.terminals.experimental_screen({ terminalId: session.id }),
      ),
    );

    expect(screens).toHaveLength(TERMINAL_SCREEN_MAX_IN_FLIGHT_READS + 1);
    for (const screen of screens) {
      expect(screen.rows.join("\n")).toContain("queue capacity");
    }
  });

  it("reads a foreign-project terminal screen with the same access as output", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const { project: foreignProject } = seedProjectWithSource(
      fixture.harness.deps,
      {
        hostId: fixture.host.id,
        path: "/tmp/foreign-terminal-project",
      },
    );
    const foreignEnvironment = seedEnvironment(fixture.harness.deps, {
      hostId: fixture.host.id,
      path: "/tmp/foreign-terminal-workspace",
      projectId: foreignProject.id,
    });
    const foreignThread = seedThread(fixture.harness.deps, {
      environmentId: foreignEnvironment.id,
      projectId: foreignProject.id,
      status: "idle",
    });
    const secretScreenRow = "foreign-project-terminal-secret";
    const foreignTerminal = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: foreignEnvironment.id,
      hostId: fixture.host.id,
      initialCwd: foreignEnvironment.path ?? "/tmp/foreign-terminal-workspace",
      rows: 32,
      status: "running",
      threadId: foreignThread.id,
      title: "Foreign project terminal",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: foreignTerminal.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from(`${secretScreenRow}\n`).toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: foreignTerminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const screenResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${foreignTerminal.id}/screen`,
    );
    const screen = await screenResponse.json();
    const outputResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${foreignTerminal.id}/output`,
    );

    expect(screenResponse.status).toBe(200);
    expect(screenResponse.status).toBe(outputResponse.status);
    expect(terminalScreenResponseSchema.parse(screen).rows).toContain(
      secretScreenRow,
    );
    expect(
      terminalOutputResponseSchema.parse(await outputResponse.json()).chunks,
    ).toEqual([
      {
        seq: 0,
        dataBase64: Buffer.from(`${secretScreenRow}\n`, "utf8").toString(
          "base64",
        ),
      },
    ]);
  });

  it("reads exited terminal output after reopening the database", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal restart retention",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("restart survived\n").toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const reopenedDb = createConnection(fixture.harness.db.$client.serialize());
    const reopenedHarness = await createTestAppHarness({ db: reopenedDb });
    harnesses.push(reopenedHarness);

    const response = await reopenedHarness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );

    expect(response.status).toBe(200);
    expect(
      terminalOutputResponseSchema.parse(await readJson(response)),
    ).toEqual(
      expect.objectContaining({
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from("restart survived\n").toString("base64"),
          },
        ],
        status: "exited",
        exitCode: 0,
      }),
    );
  });

  it("retains a large daemon replay in one pass instead of rewriting the buffer per chunk", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const replayLogs = vi.spyOn(fixture.harness.deps.logger, "info");
    const terminal = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Long replay",
    });
    const chunks = Array.from({ length: 10_000 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(
        `line ${String(seq).padStart(5, "0")} `.padEnd(200, "x"),
      ).toString("base64"),
    }));
    fixture.harness.db.$client.exec(`
      CREATE TABLE replay_write_count (n INTEGER NOT NULL);
      INSERT INTO replay_write_count (n) VALUES (0);
      CREATE TRIGGER count_replay_insert AFTER INSERT ON fork_terminal_output
        BEGIN UPDATE replay_write_count SET n = n + 1; END;
      CREATE TRIGGER count_replay_update AFTER UPDATE ON fork_terminal_output
        BEGIN UPDATE replay_write_count SET n = n + 1; END;
    `);

    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "long-replay",
        terminalId: terminal.id,
        chunks,
        replayStartSeq: 0,
        nextSeq: chunks.length,
      },
    });
    expect(eventLoopYielded).toBe(true);
    const replayLog = replayLogs.mock.calls.find(
      ([, message]) => message === "Terminal replay attributed",
    );
    const replayMetrics = replayLog?.[0] as Record<string, number> | undefined;
    const expectedReplayBytes = chunks.reduce(
      (total, chunk) =>
        total + Buffer.byteLength(chunk.dataBase64, "base64"),
      0,
    );
    expect(replayMetrics).toMatchObject({
      replayBytes: expectedReplayBytes,
      replayChunks: chunks.length,
      maxRetainedWriteBatchBytes: expect.any(Number),
      maxRetainedWriteBatchChunks: expect.any(Number),
    });
    expect(replayMetrics?.retainedWriteChunks).toBeGreaterThan(0);
    expect(replayMetrics?.retainedWriteChunks).toBeLessThan(chunks.length);
    expect(replayMetrics?.retainedWriteBytes).toBeLessThanOrEqual(64 * 1024);
    expect(replayMetrics?.maxRetainedWriteBatchBytes).toBeLessThanOrEqual(
      64 * 1024,
    );
    const retainedWriteTransactions = fixture.harness.db.$client
      .prepare("SELECT n FROM replay_write_count")
      .get() as { n: number };
    expect(retainedWriteTransactions.n).toBeLessThanOrEqual(1);

    const retained = retainedAfterFlush(
      fixture.harness.deps.terminalSessions,
      fixture.harness.db,
      {
        hostId: fixture.host.id,
        terminalSessionId: terminal.id,
        now: Date.now(),
      },
    );
    expect(retained?.at(-1)).toEqual(chunks.at(-1));
    expect(retained?.map((chunk) => chunk.seq)).toEqual(
      chunks
        .slice(chunks.length - (retained?.length ?? 0))
        .map((chunk) => chunk.seq),
    );
  }, 60_000);

  it("retains every replay chunk after a disconnected browser attach raises its forwarded sequence", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const terminal = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Replay after reattach",
    });
    updateTerminalSession(fixture.harness.db, {
      scope: { kind: "terminal", terminalId: terminal.id },
      update: { kind: "disconnect", retainDaemonSession: true },
    });
    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      socket: createFakeBrowserSocket(),
      sinceSeq: 100,
      terminalId: terminal.id,
    });
    updateTerminalSession(fixture.harness.db, {
      scope: { kind: "terminal", terminalId: terminal.id },
      update: { kind: "reconnect", daemonSessionId: fixture.session.id },
    });
    const chunks = Array.from({ length: 4 }, (_, seq) => ({
      seq,
      dataBase64: Buffer.from(`replayed-${seq}`).toString("base64"),
    }));

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "reattach-sequence-replay",
        terminalId: terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });

    const retained = getRetainedTerminalOutput(fixture.harness.db, {
      hostId: fixture.host.id,
      terminalSessionId: terminal.id,
      now: Date.now(),
    });
    expect(retained?.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
  });

  it("retains received replay bytes when its daemon socket closes", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const terminal = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Replay socket close",
    });
    const chunks = [
      {
        seq: 0,
        dataBase64: Buffer.alloc(300 * 1024, "x").toString("base64"),
      },
    ];
    const terminalSessions = fixture.harness.deps.terminalSessions;
    const rpcKey = (requestId: string) =>
      `${fixture.session.id}\0${terminal.id}\0${requestId}`;
    const registry = (name: string) => {
      const value = Reflect.get(terminalSessions, name);
      if (
        typeof value !== "object" ||
        value === null ||
        !("claim" in value) ||
        typeof value.claim !== "function" ||
        !("settle" in value) ||
        typeof value.settle !== "function"
      ) {
        throw new Error(`Terminal pending registry ${name} is unavailable`);
      }
      return value as {
        claim(key: Record<string, unknown>): { promise: Promise<unknown> };
        settle(key: string, result: unknown): boolean;
      };
    };
    const attachSocket = createFakeBrowserSocket();
    const attachRegistry = registry("pendingAttaches");
    const readRegistry = registry("pendingOutputReads");
    const catchUpRegistry = registry("pendingCatchUps");
    const attached = attachRegistry
      .claim({
        daemonSessionId: fixture.session.id,
        requestId: "socket-close-replay",
        rpcKey: rpcKey("socket-close-replay"),
        socket: attachSocket,
        terminalId: terminal.id,
      })
      .promise.catch((error: unknown) => error);
    const read = readRegistry
      .claim({
        daemonSessionId: fixture.session.id,
        requestId: "socket-close-replay",
        rpcKey: rpcKey("socket-close-replay"),
        terminalId: terminal.id,
      })
      .promise.catch((error: unknown) => error);
    const catchUp = catchUpRegistry
      .claim({
        daemonSessionId: fixture.session.id,
        requestId: "socket-close-replay",
        rpcKey: rpcKey("socket-close-replay"),
        terminalId: terminal.id,
      })
      .promise.catch((error: unknown) => error);
    const attachSettled = vi.spyOn(attachRegistry, "settle");
    const readSettled = vi.spyOn(readRegistry, "settle");
    const catchUpSettled = vi.spyOn(catchUpRegistry, "settle");
    const replay = terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "socket-close-replay",
        terminalId: terminal.id,
        replayStartSeq: 0,
        nextSeq: chunks.length,
        chunks,
      },
    });
    setImmediate(() => {
      terminalSessions.handleDaemonSessionClosed({
        sessionId: fixture.session.id,
      });
    });
    const [attachError, readError, catchUpError] = await Promise.all([
      attached,
      read,
      catchUp,
      replay,
    ]);

    expect(attachError).toMatchObject({ body: { code: "host_disconnected" } });
    expect(readError).toMatchObject({ body: { code: "host_disconnected" } });
    expect(catchUpError).toMatchObject({ body: { code: "host_disconnected" } });
    expect(attachSettled).not.toHaveBeenCalled();
    expect(readSettled).not.toHaveBeenCalled();
    expect(catchUpSettled).not.toHaveBeenCalled();
    expect(readBrowserMessages(attachSocket)).toEqual([
      expect.objectContaining({ type: "error", code: "host_disconnected" }),
    ]);

    const retained = getRetainedTerminalOutput(fixture.harness.db, {
      hostId: fixture.host.id,
      terminalSessionId: terminal.id,
      now: Date.now(),
    });
    expect(retained).toEqual([
      {
        seq: 0,
        dataBase64: Buffer.alloc(64 * 1024, "x").toString("base64"),
      },
    ]);
    expect(new Set(retained?.map(({ seq }) => seq)).size).toBe(retained?.length);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: terminal.id,
      }),
    ).toMatchObject({
      daemonSessionId: fixture.session.id,
      status: "disconnected",
    });
    const expiry = fixture.harness.db.$client
      .prepare(
        "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
      )
      .get(terminal.id) as { expiresAt: number | null } | undefined;
    expect(expiry?.expiresAt).toBeNull();
  });

  it("discards replay after a daemon restart changes the sequence offset mid-replay", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const replayInfo = vi.spyOn(fixture.harness.deps.logger, "info");
    const terminal = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Replay offset reset",
    });
    const sequenceRebase = Reflect.get(
      fixture.harness.deps.terminalSessions,
      "outputSequenceRebase",
    );
    if (
      typeof sequenceRebase !== "object" ||
      sequenceRebase === null ||
      !("setBase" in sequenceRebase) ||
      typeof sequenceRebase.setBase !== "function"
    ) {
      throw new Error("Terminal replay sequence rebase is unavailable");
    }
    updateTerminalSession(fixture.harness.db, {
      scope: { kind: "terminal", terminalId: terminal.id },
      update: { kind: "holder-backed" },
    });
    appendRetainedTerminalOutputChunks(fixture.harness.db, {
      hostId: fixture.host.id,
      terminalSessionId: terminal.id,
      chunks: [{ seq: 5, dataBase64: Buffer.from("old").toString("base64") }],
      clock: Date.now,
    });
    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.session.id,
    });
    const nextSession = seedSession(fixture.harness.deps, fixture.host.id, {
      instanceId: "replay-instance-2",
    });
    await fixture.harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
      daemonSessionId: nextSession.id,
      hostId: fixture.host.id,
    });
    const attachSocket = createFakeBrowserSocket();
    const pendingAttaches = Reflect.get(
      fixture.harness.deps.terminalSessions,
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
    const attachRpcKey = `${nextSession.id}\0${terminal.id}\0offset-reset-replay`;
    const attachSettlement = vi.spyOn(pendingAttachRegistry, "settle");
    const pendingAttach = pendingAttachRegistry.claim({
      daemonSessionId: nextSession.id,
      requestId: "offset-reset-replay",
      rpcKey: attachRpcKey,
      socket: attachSocket,
      terminalId: terminal.id,
    }).promise.catch((error: unknown) => error);
    const chunks = Array.from({ length: 2_000 }, (_, seq) => ({
      seq: 200 + seq,
      dataBase64: Buffer.alloc(400, "x").toString("base64"),
    }));
    let replaySettled = false;
    const replay = fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: nextSession.id,
      message: {
        type: "terminal.replay",
        requestId: "offset-reset-replay",
        terminalId: terminal.id,
        replayStartSeq: 0,
        nextSeq: 2_200,
        chunks,
      },
    }).finally(() => {
      replaySettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replaySettled).toBe(false);
    appendRetainedTerminalOutputChunks(fixture.harness.db, {
      hostId: fixture.host.id,
      terminalSessionId: terminal.id,
      chunks: [{ seq: 100, dataBase64: Buffer.from("new").toString("base64") }],
      clock: Date.now,
    });
    sequenceRebase.setBase(terminal.id, 101);
    const [attachError] = await Promise.all([pendingAttach, replay]);

    const retained = getRetainedTerminalOutput(fixture.harness.db, {
      hostId: fixture.host.id,
      terminalSessionId: terminal.id,
      now: Date.now(),
    });
    expect(retained?.map(({ seq }) => seq)).toEqual([5, 100]);
    expect(attachError).toMatchObject({
      status: 409,
      body: { code: "terminal_replaced" },
    });
    expect(attachSettlement).not.toHaveBeenCalled();
    expect(readBrowserMessages(attachSocket)).toContainEqual(
      expect.objectContaining({ type: "error", code: "terminal_replaced" }),
    );
    expect(
      replayInfo.mock.calls.some(
        ([, message]) => message === "Terminal replay attributed",
      ),
    ).toBe(false);
    const discard = replayInfo.mock.calls.find(
      ([, message]) => message === "Terminal replay discarded after ownership change",
    );
    expect(discard).toBeDefined();
    expect(discard?.[0]).not.toHaveProperty("retainedWriteBytes");
    expect(discard?.[0]).not.toHaveProperty("retainedWriteChunks");
  });

  it("accepts retained output only from the terminal's owning host", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    const foreignHost = seedHostSession(fixture.harness, {
      id: "host-foreign",
      name: "Foreign Host",
    });
    const makeOwnedTerminal = (title: string) =>
      createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title,
      });
    const trustedTerminal = makeOwnedTerminal("Trusted terminal output");
    const exitedTerminal = makeOwnedTerminal("Trusted terminal exit");
    const replayTerminal = makeOwnedTerminal("Trusted terminal replay");
    const trustedChunk = {
      seq: 0,
      dataBase64: Buffer.from("owner output\n").toString("base64"),
    };
    const foreignChunk = {
      seq: 1,
      dataBase64: Buffer.from("foreign poison\n").toString("base64"),
    };
    const replayChunk = {
      seq: 0,
      dataBase64: Buffer.from("owner replay\n").toString("base64"),
    };

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: trustedTerminal.id,
        chunk: trustedChunk,
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: foreignHost.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: trustedTerminal.id,
        chunk: foreignChunk,
      },
    });
    expect(
      retainedAfterFlush(
        fixture.harness.deps.terminalSessions,
        fixture.harness.db,
        {
          hostId: fixture.host.id,
          terminalSessionId: trustedTerminal.id,
          now: Date.now(),
        },
      ),
    ).toEqual([trustedChunk]);
    expect(
      fixture.harness.deps.terminalSessions.getTerminal({
        terminalId: trustedTerminal.id,
      }),
    ).toMatchObject({
      status: "running",
      exitCode: null,
      closeReason: null,
    });

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: exitedTerminal.id,
        chunk: trustedChunk,
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: foreignHost.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: exitedTerminal.id,
        exitCode: 137,
        closeReason: "process-exit",
      },
    });
    expect(
      fixture.harness.deps.terminalSessions.getTerminal({
        terminalId: exitedTerminal.id,
      }),
    ).toMatchObject({
      status: "running",
      exitCode: null,
      closeReason: null,
    });
    expect(
      retainedAfterFlush(
        fixture.harness.deps.terminalSessions,
        fixture.harness.db,
        {
          hostId: fixture.host.id,
          terminalSessionId: exitedTerminal.id,
          now: Date.now(),
        },
      ),
    ).toEqual([trustedChunk]);
    expect(
      fixture.harness.db.$client
        .prepare(
          "SELECT expires_at AS expiresAt FROM fork_terminal_output WHERE terminal_session_id = ?",
        )
        .get(exitedTerminal.id),
    ).toEqual({ expiresAt: null });

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: foreignHost.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "foreign-replay",
        terminalId: trustedTerminal.id,
        chunks: [foreignChunk],
        replayStartSeq: 1,
        nextSeq: 2,
      },
    });
    expect(
      retainedAfterFlush(
        fixture.harness.deps.terminalSessions,
        fixture.harness.db,
        {
          hostId: fixture.host.id,
          terminalSessionId: trustedTerminal.id,
          now: Date.now(),
        },
      ),
    ).toEqual([trustedChunk]);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: trustedTerminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const unchangedResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${trustedTerminal.id}/output`,
    );
    expect(
      terminalOutputResponseSchema.parse(await readJson(unchangedResponse))
        .chunks,
    ).toEqual([trustedChunk]);

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: foreignHost.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "foreign-replay-only",
        terminalId: replayTerminal.id,
        chunks: [replayChunk],
        replayStartSeq: 0,
        nextSeq: 1,
      },
    });
    expect(
      retainedAfterFlush(
        fixture.harness.deps.terminalSessions,
        fixture.harness.db,
        {
          hostId: fixture.host.id,
          terminalSessionId: replayTerminal.id,
          now: Date.now(),
        },
      ),
    ).toBeNull();

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: "owner-replay",
        terminalId: replayTerminal.id,
        chunks: [replayChunk],
        replayStartSeq: 0,
        nextSeq: 1,
      },
    });
    expect(
      retainedAfterFlush(
        fixture.harness.deps.terminalSessions,
        fixture.harness.db,
        {
          hostId: fixture.host.id,
          terminalSessionId: replayTerminal.id,
          now: Date.now(),
        },
      ),
    ).toEqual([replayChunk]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: foreignHost.host.id,
        ownerHostId: fixture.host.id,
        terminalId: trustedTerminal.id,
      }),
      "Ignoring terminal replay from a non-owner host",
    );
  });

  it.each(["€", "🙂"])(
    "keeps split UTF-8 character %s intact when limiting exited output by lines",
    async (glyph) => {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);
      const session = createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title: "Terminal UTF-8 line limit",
      });
      const glyphBytes = Buffer.from(glyph);
      const outputChunks = [
        Buffer.concat([Buffer.from("before\n"), glyphBytes.subarray(0, 1)]),
        Buffer.concat([glyphBytes.subarray(1), Buffer.from(" after\n")]),
      ].map((bytes, index) => ({
        seq: index,
        dataBase64: bytes.toString("base64"),
      }));
      for (const chunk of outputChunks) {
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: { type: "terminal.output", terminalId: session.id, chunk },
        });
      }
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: session.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });

      const response = await fixture.harness.app.request(
        `/api/v1/terminals/${session.id}/output?lines=2`,
      );

      expect(response.status).toBe(200);
      const result = terminalOutputResponseSchema.parse(
        await readJson(response),
      );
      expect(
        Buffer.concat(
          result.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
        ).toString("utf8"),
      ).toBe(`before\n${glyph} after\n`);
    },
  );

  it("evicts the oldest output chunk at the per-host cap", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const sessions = Array.from({ length: 33 }, (_, index) =>
      createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title: `Terminal ${index}`,
      }),
    );
    const chunkBytes = Buffer.alloc(16 * 1024, 65);
    for (const session of sessions) {
      const chunkCount = session === sessions.at(-1) ? 1 : 4;
      for (let seq = 0; seq < chunkCount; seq += 1) {
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.output",
            terminalId: session.id,
            chunk: { seq, dataBase64: chunkBytes.toString("base64") },
          },
        });
      }
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: session.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
    }
    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${sessions[0].id}/output`,
    );
    expect(response.status).toBe(200);
    const output = terminalOutputResponseSchema.parse(await readJson(response));
    expect(output.chunks[0]?.seq).toBe(1);
    expect(output.chunks).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it("keeps at most 128 retained terminal buffers per host", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const sessions = Array.from({ length: 129 }, (_, index) =>
      createTerminalSession(fixture.harness.db, {
        cols: 120,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
        rows: 32,
        status: "running",
        threadId: fixture.thread.id,
        title: `Retained terminal ${index}`,
      }),
    );
    for (const session of sessions) {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: session.id,
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("retained\n").toString("base64"),
          },
        },
      });
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: session.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
    }

    const oldestResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${sessions[0]?.id}/output`,
    );
    const newestResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${sessions.at(-1)?.id}/output`,
    );

    expect(oldestResponse.status).toBe(409);
    expect(newestResponse.status).toBe(200);
  });

  it("keeps only the last 64 KiB for one terminal", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Bounded retained terminal",
    });
    const dataBase64 = Buffer.alloc(16 * 1024, 65).toString("base64");
    for (let seq = 0; seq < 5; seq += 1) {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: session.id,
          chunk: { seq, dataBase64 },
        },
      });
    }
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );

    expect(response.status).toBe(200);
    const output = terminalOutputResponseSchema.parse(await readJson(response));
    expect(output.chunks.map((chunk) => chunk.seq)).toEqual([1, 2, 3, 4]);
    expect(
      output.chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.dataBase64, "base64"),
        0,
      ),
    ).toBe(64 * 1024);
    expect(output.truncated).toBe(true);
  });

  it("expires server-retained terminal output after 30 minutes", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    vi.useFakeTimers();
    try {
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: session.id,
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("hello\n").toString("base64"),
          },
        },
      });
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.exited",
          terminalId: session.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const response = await fixture.harness.app.request(
        `/api/v1/terminals/${session.id}/output`,
      );
      expect(response.status).toBe(409);
      expect(apiErrorSchema.parse(await readJson(response)).code).toBe(
        "terminal_output_unavailable",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to retained output when a terminal exits during the read", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const responsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );
    await waitForDaemonMessage(fixture.socket);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: session.id,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("build failed\n", "utf8").toString("base64"),
        },
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: session.id,
        exitCode: 2,
        closeReason: "process-exit",
      },
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(
      terminalOutputResponseSchema.parse(await readJson(response)),
    ).toEqual({
      chunks: [
        {
          seq: 0,
          dataBase64: Buffer.from("build failed\n", "utf8").toString("base64"),
        },
      ],
      nextSeq: 1,
      truncated: false,
      status: "exited",
      exitCode: 2,
      closeReason: "process-exit",
    });
  });

  it("explains when the server has no retained output for an exited terminal", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = seedExitedTerminalSession(fixture, {
      daemonSessionId: fixture.session.id,
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_output_unavailable",
      message: expect.stringContaining("30 minutes"),
    });
  });

  it("does not need a connected host to explain missing retained output", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = seedExitedTerminalSession(fixture, {
      daemonSessionId: fixture.session.id,
    });
    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.session.id,
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );

    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_output_unavailable",
      message: expect.stringContaining("30 minutes"),
    });
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
  });

  it("rejects output reads for terminals that are not running", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const session = createTerminalSession(fixture.harness.db, {
      cols: 120,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: fixture.environment.path ?? "/tmp/terminal-workspace",
      rows: 32,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    markDaemonTerminalSessionsDisconnected(fixture.harness.db, {
      daemonSessionId: fixture.session.id,
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/output`,
    );

    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_output_unavailable",
      message:
        "Terminal output is unavailable because the session is not running",
    });
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
  });

  it("does not resurrect a pending terminal after thread deletion", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const { openMessage, responsePromise } =
      await startPendingTerminalOpen(fixture);

    markThreadTerminalSessionsExited(fixture.harness.db, {
      threadId: fixture.thread.id,
      closeReason: "thread-deleted",
    });
    acknowledgeTerminalOpen(fixture, openMessage);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_open_cancelled",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: openMessage.terminalId,
        closeReason: "thread-deleted",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
    const closeMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: openMessage.terminalId,
      reason: "thread-deleted",
    });
  });

  it("does not resurrect a pending terminal after environment destruction", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const { openMessage, responsePromise } =
      await startPendingTerminalOpen(fixture);

    markEnvironmentTerminalSessionsExited(fixture.harness.db, {
      environmentId: fixture.environment.id,
      closeReason: "environment-destroyed",
    });
    acknowledgeTerminalOpen(fixture, openMessage);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_open_cancelled",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: openMessage.terminalId,
        closeReason: "environment-destroyed",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
    const closeMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: openMessage.terminalId,
      reason: "environment-destroyed",
    });
  });

  it("does not resurrect a pending terminal after daemon disconnect", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const { openMessage, responsePromise } =
      await startPendingTerminalOpen(fixture);

    markDaemonTerminalSessionsDisconnected(fixture.harness.db, {
      daemonSessionId: fixture.session.id,
    });
    acknowledgeTerminalOpen(fixture, openMessage);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_open_cancelled",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: openMessage.terminalId,
        daemonSessionId: null,
        status: "disconnected",
      }),
    ]);
    const closeMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: openMessage.terminalId,
      reason: "daemon-disconnect",
    });
  });

  it("marks timed-out terminal opens exited", async () => {
    const fixture = await createTerminalRouteFixture({
      terminalOpenTimeoutMs: 50,
    });
    harnesses.push(fixture.harness);

    const response = await fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cols: 80,
        rows: 24,
        target: { kind: "thread", threadId: fixture.thread.id },
      }),
    });

    expect(response.status).toBe(504);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "terminal_open_timeout",
    });
    const sessions = listTerminalSessionsByThread(
      fixture.harness.db,
      fixture.thread.id,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      closeReason: "open-timeout",
      status: "exited",
    });
    const closeMessage = readDaemonOperationMessages(fixture.socket)[1];
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      reason: "open-timeout",
    });
  });

  it("reads only the daemon session row for output from a terminal no browser is watching", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const sqlite = fixture.harness.db.$client;
    const prepare = sqlite.prepare.bind(sqlite);
    const preparedSources: string[] = [];
    const prepared = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((source: string) => {
        preparedSources.push(source);
        return prepare(source);
      });
    const sendOutput = (seq: number) =>
      onDaemonSocketMessage(fixture.harness.deps, {
        hostId: fixture.host.id,
        raw: JSON.stringify({
          type: "terminal.output",
          terminalId: stored.id,
          chunk: {
            seq,
            dataBase64: Buffer.from(`chunk-${seq}`).toString("base64"),
          },
        }),
        sessionId: fixture.session.id,
        socket: fixture.socket,
      });

    sendOutput(0);
    sendOutput(1);
    expect(preparedSources).toHaveLength(2);
    for (const source of preparedSources) {
      expect(source).toMatch(/^\s*select\b/iu);
      expect(source).toMatch(/\bhost_daemon_sessions\b/u);
      expect(source).not.toMatch(/\bterminal_sessions\b/u);
    }
    expect(fixture.socket.close).not.toHaveBeenCalled();
    preparedSources.length = 0;

    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);
    sendOutput(2);

    expect(prepared).toHaveBeenCalled();
    expect(
      readBrowserMessages(browserSocket).flatMap((message) =>
        message.type === "output" ? [message.chunk.seq] : [],
      ),
    ).toEqual([2]);
  });

  it("evicts a closed daemon session from the hub when it sends output for an unwatched terminal", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const closeRequests: [number | undefined, string | undefined][] = [];
    const evictingSocket: FakeDaemonSocket = {
      close: vi.fn((code?: number, reason?: string) => {
        closeRequests.push([code, reason]);
        onDaemonSocketClose(fixture.harness.deps, fixture.session.id);
      }),
      send: vi.fn(),
      sentMessages: [],
    };
    fixture.harness.hub.registerDaemon(
      fixture.session.id,
      fixture.host.id,
      evictingSocket,
    );
    closeSession(
      fixture.harness.deps.db,
      fixture.harness.deps.hub,
      fixture.session.id,
      "daemon-disconnect",
    );
    expect(fixture.harness.hub.hasDaemonForHost(fixture.host.id)).toBe(true);
    expect(fixture.harness.hub.hasTerminalClients(stored.id)).toBe(false);
    fixture.harness.hub.takeSilentDaemonSessionIds(1);

    const sqlite = fixture.harness.db.$client;
    const prepare = sqlite.prepare.bind(sqlite);
    const preparedSources: string[] = [];
    vi.spyOn(sqlite, "prepare").mockImplementation((source: string) => {
      preparedSources.push(source);
      return prepare(source);
    });
    onDaemonSocketMessage(fixture.harness.deps, {
      hostId: fixture.host.id,
      raw: JSON.stringify({
        type: "terminal.output",
        terminalId: stored.id,
        chunk: { seq: 0, dataBase64: Buffer.from("late").toString("base64") },
      }),
      sessionId: fixture.session.id,
      socket: evictingSocket,
    });

    expect(closeRequests).toEqual([[1008, "inactive-session"]]);
    expect(fixture.harness.hub.hasDaemonForHost(fixture.host.id)).toBe(false);
    expect(
      fixture.harness.hub.sendDaemonSessionMessage(fixture.session.id, {
        type: "heartbeat-ack",
      }),
    ).toBe(false);
    expect(evictingSocket.sentMessages).toEqual([]);
    expect(fixture.harness.hub.takeSilentDaemonSessionIds(1)).toEqual([]);
    expect(fixture.harness.hub.takeSilentDaemonSessionIds(1)).toEqual([]);
    expect(fixture.harness.hub.hasDaemonForHost(fixture.host.id)).toBe(false);
    for (const source of preparedSources) {
      expect(source).not.toMatch(/\bterminal_sessions\b/u);
    }
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: stored.id,
      })?.status,
    ).toBe("running");
  });

  it("replays output produced while nobody watched and resumes live output and acks after the last browser detaches and reattaches", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const scrollback: { seq: number; dataBase64: string }[] = [];
    const daemonProduces = (text: string) => {
      const chunk = {
        seq: scrollback.length,
        dataBase64: Buffer.from(text).toString("base64"),
      };
      scrollback.push(chunk);
      onDaemonSocketMessage(fixture.harness.deps, {
        hostId: fixture.host.id,
        raw: JSON.stringify({
          type: "terminal.output",
          terminalId: stored.id,
          chunk,
        }),
        sessionId: fixture.session.id,
        socket: fixture.socket,
      });
    };
    let answeredAttaches = 0;
    const daemonAnswersAttach = async () => {
      const attaches = readDaemonOperationMessages(fixture.socket).filter(
        (message) => message.type === "terminal.attach",
      );
      const attach = attaches[answeredAttaches];
      if (attach?.type !== "terminal.attach") {
        throw new Error("Expected a terminal.attach request");
      }
      answeredAttaches += 1;
      const chunks = scrollback.filter((chunk) => chunk.seq >= attach.sinceSeq);
      await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: attach.requestId,
          terminalId: stored.id,
          chunks,
          replayStartSeq: chunks[0]?.seq ?? scrollback.length,
          nextSeq: scrollback.length,
        },
      });
    };
    const outputSeqs = (socket: FakeBrowserSocket) =>
      readBrowserMessages(socket).flatMap((message) =>
        message.type === "output" ? [message.chunk.seq] : [],
      );
    const flowMessages = () =>
      readDaemonOperationMessages(fixture.socket).filter(
        (message) =>
          message.type === "terminal.flow-control" ||
          message.type === "terminal.ack",
      );
    const ack = (socket: FakeBrowserSocket, nextSeq: number) =>
      onTerminalSocketMessage(fixture.harness.deps, {
        raw: JSON.stringify({ type: "ack", nextSeq }),
        socket,
        terminalId: stored.id,
      });

    daemonProduces("unwatched-0");
    daemonProduces("unwatched-1");
    expect(flowMessages()).toEqual([]);

    const first = createFakeBrowserSocket();
    onTerminalSocketOpen(fixture.harness.deps, {
      outputAcks: true,
      resizeAcks: false,
      sinceSeq: 0,
      socket: first,
      terminalId: stored.id,
    });
    await daemonAnswersAttach();
    expect(readBrowserMessages(first)[0]).toMatchObject({
      type: "attached",
      replayStartSeq: 0,
      nextSeq: 2,
    });
    expect(outputSeqs(first)).toEqual([0, 1]);

    daemonProduces("live-2");
    daemonProduces("live-3");
    expect(outputSeqs(first)).toEqual([0, 1, 2, 3]);
    ack(first, 4);
    expect(flowMessages()).toEqual([
      { type: "terminal.flow-control", terminalId: stored.id, enabled: true },
      { type: "terminal.ack", terminalId: stored.id, nextSeq: 4 },
    ]);

    onTerminalSocketClose(fixture.harness.deps, {
      socket: first,
      terminalId: stored.id,
    });
    expect(flowMessages().at(-1)).toEqual({
      type: "terminal.flow-control",
      terminalId: stored.id,
      enabled: false,
    });
    expect(fixture.harness.hub.hasTerminalClients(stored.id)).toBe(false);

    const flowCountAfterDetach = flowMessages().length;
    daemonProduces("unwatched-4");
    daemonProduces("unwatched-5");
    expect(flowMessages()).toHaveLength(flowCountAfterDetach);

    const second = createFakeBrowserSocket();
    onTerminalSocketOpen(fixture.harness.deps, {
      outputAcks: true,
      resizeAcks: false,
      sinceSeq: 4,
      socket: second,
      terminalId: stored.id,
    });
    await daemonAnswersAttach();
    expect(readBrowserMessages(second)[0]).toMatchObject({
      type: "attached",
      replayStartSeq: 4,
      nextSeq: 6,
    });
    expect(outputSeqs(second)).toEqual([4, 5]);

    daemonProduces("live-6");
    daemonProduces("live-7");
    expect(outputSeqs(second)).toEqual([4, 5, 6, 7]);
    ack(second, 8);
    expect(flowMessages().slice(flowCountAfterDetach)).toEqual([
      { type: "terminal.flow-control", terminalId: stored.id, enabled: true },
      { type: "terminal.ack", terminalId: stored.id, nextSeq: 8 },
    ]);

    onTerminalSocketClose(fixture.harness.deps, {
      socket: second,
      terminalId: stored.id,
    });
    expect(flowMessages().at(-1)).toEqual({
      type: "terminal.flow-control",
      terminalId: stored.id,
      enabled: false,
    });
  });

  it("reattaches disconnected terminals when the same daemon instance reconnects and replays the output browsers missed", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);
    const chunk = (seq: number) => ({
      seq,
      dataBase64: Buffer.from(`chunk-${seq}`).toString("base64"),
    });
    const sendOutput = (sessionId: string, seq: number) =>
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId,
        message: {
          type: "terminal.output",
          terminalId: stored.id,
          chunk: chunk(seq),
        },
      });
    const browserOutputSeqs = () =>
      readBrowserMessages(browserSocket).flatMap((message) =>
        message.type === "output" ? [message.chunk.seq] : [],
      );

    sendOutput(fixture.session.id, 0);
    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.session.id,
    });
    const replacementSession = seedSession(
      fixture.harness.deps,
      fixture.host.id,
    );
    const replacementSocket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.host.id,
      sessionId: replacementSession.id,
      socket: replacementSocket,
    });

    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        terminalId: stored.id,
        threadId: fixture.thread.id,
      }),
    ).toMatchObject({
      daemonSessionId: replacementSession.id,
      status: "running",
    });
    expect(readBrowserMessages(browserSocket).at(-1)).toMatchObject({
      type: "session-updated",
      session: { id: stored.id, status: "running" },
    });
    const attach = readDaemonOperationMessages(replacementSocket).find(
      (message) => message.type === "terminal.attach",
    );
    if (attach?.type !== "terminal.attach") {
      throw new Error("Expected a catch-up terminal.attach");
    }
    expect(attach).toMatchObject({
      terminalId: stored.id,
      sinceSeq: 1,
      tailBytes: 4 * 1024 * 1024,
    });
    expect(
      readDaemonOperationMessages(replacementSocket).some(
        (message) => message.type === "terminal.close",
      ),
    ).toBe(false);

    sendOutput(replacementSession.id, 3);
    expect(browserOutputSeqs()).toEqual([0]);

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: replacementSession.id,
      message: {
        type: "terminal.replay",
        requestId: attach.requestId,
        terminalId: stored.id,
        chunks: [chunk(1), chunk(2), chunk(3)],
        replayStartSeq: 1,
        nextSeq: 4,
      },
    });
    sendOutput(replacementSession.id, 4);

    expect(browserOutputSeqs()).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([
    { name: "whose terminal is already disconnected", closeSession: true },
    { name: "before its daemon has re-registered", closeSession: false },
  ])(
    "keeps a browser that attaches $name and catches it up when the terminal reattaches",
    async ({ closeSession }) => {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);
      const stored = createTerminalSession(fixture.harness.db, {
        cols: 80,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: "/tmp/terminal-workspace",
        rows: 24,
        status: "running",
        threadId: fixture.thread.id,
        title: "Terminal 1",
      });
      if (closeSession) {
        handleDaemonSocketClosed(fixture.harness.deps, {
          sessionId: fixture.session.id,
        });
      } else {
        fixture.harness.hub.unregisterDaemon(fixture.session.id);
      }
      const browserSocket = createFakeBrowserSocket();
      fixture.harness.deps.terminalSessions.attachBrowserTerminal({
        outputAcks: false,
        resizeAcks: false,
        socket: browserSocket,
        sinceSeq: 5,
        terminalId: stored.id,
      });

      fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
        message: { type: "resize", cols: 100, rows: 30 },
        socket: browserSocket,
        terminalId: stored.id,
      });
      fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
        message: { type: "input", dataBase64: btoa("ls\n") },
        socket: browserSocket,
        terminalId: stored.id,
      });
      expect(
        readBrowserMessages(browserSocket).filter(
          (message) => message.type === "error",
        ),
      ).toEqual([]);
      expect(
        getTerminalSessionForThread(fixture.harness.db, {
          terminalId: stored.id,
          threadId: fixture.thread.id,
        }),
      ).toMatchObject({ status: "disconnected" });

      const replacementSession = seedSession(
        fixture.harness.deps,
        fixture.host.id,
      );
      const replacementSocket = createFakeDaemonSocket();
      onDaemonSocketOpen(fixture.harness.deps, {
        hostId: fixture.host.id,
        sessionId: replacementSession.id,
        socket: replacementSocket,
      });

      expect(readBrowserMessages(browserSocket).at(-1)).toMatchObject({
        type: "session-updated",
        session: { id: stored.id, status: "running" },
      });
      expect(
        readDaemonOperationMessages(replacementSocket).find(
          (message) => message.type === "terminal.attach",
        ),
      ).toMatchObject({ terminalId: stored.id, sinceSeq: 5 });
    },
  );

  it("expires disconnected terminals when a restarted daemon instance reconnects", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);

    fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: fixture.session.id,
    });
    const replacement = {
      session: seedSession(fixture.harness.deps, fixture.host.id, {
        instanceId: "instance-restarted",
      }),
    };
    const replacementSocket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.host.id,
      sessionId: replacement.session.id,
      socket: replacementSocket,
    });

    expect(await waitForDaemonMessage(replacementSocket)).toEqual({
      type: "connect-shares.replace",
      generation: 0,
      ports: [],
    });
    const closeMessage = await waitForDaemonMessage(replacementSocket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "daemon-disconnect",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: stored.id,
        closeReason: "daemon-disconnect",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "exited",
        session: expect.objectContaining({
          id: stored.id,
          closeReason: "daemon-disconnect",
          status: "exited",
        }),
      }),
    );
  });

  it("expires terminals when a replacement daemon session opens before the old socket closes", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);

    const replacementSession = seedSession(
      fixture.harness.deps,
      fixture.host.id,
      { instanceId: "instance-restarted" },
    );
    await handleHostSessionOpened(fixture.harness.deps, {
      activeThreads: [],
      adoptedThreads: [],
      undeliveredEventThreadIds: [],
      hostId: fixture.host.id,
      openedSession: replacementSession,
      previousSession: fixture.session,
    });

    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: stored.id,
        daemonSessionId: fixture.session.id,
        status: "disconnected",
      }),
    ]);

    const replacementSocket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.host.id,
      sessionId: replacementSession.id,
      socket: replacementSocket,
    });

    expect(await waitForDaemonMessage(replacementSocket)).toEqual({
      type: "connect-shares.replace",
      generation: 0,
      ports: [],
    });
    const closeMessage = await waitForDaemonMessage(replacementSocket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "daemon-disconnect",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: stored.id,
        closeReason: "daemon-disconnect",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "exited",
        session: expect.objectContaining({
          id: stored.id,
          closeReason: "daemon-disconnect",
          status: "exited",
        }),
      }),
    );
  });

  it("marks running terminals disconnected when their daemon socket closes, keeping the owning session", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);

    handleDaemonSocketClosed(fixture.harness.deps, {
      sessionId: fixture.session.id,
    });

    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        daemonSessionId: fixture.session.id,
        id: stored.id,
        status: "disconnected",
      }),
    ]);
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "session-updated",
        session: expect.objectContaining({
          id: stored.id,
          status: "disconnected",
        }),
      }),
    );
  });

  it("closes terminal sessions when the owning thread is deleted", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);

    const response = await fixture.harness.app.request(
      `/api/v1/threads/${fixture.thread.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadsConfirmed: false }),
      },
    );

    expect(response.status).toBe(200);
    const closeMessage = await waitForDaemonMessage(fixture.socket);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "thread-deleted",
    });
    const storageDeleteRequest = await waitForDaemonMessage(fixture.socket, 1);
    expect(storageDeleteRequest).toMatchObject({
      type: "host-rpc.request",
      command: {
        type: "thread.storage.delete",
        threadId: fixture.thread.id,
      },
    });
    if (storageDeleteRequest.type !== "host-rpc.request") {
      throw new Error("Expected thread storage deletion request");
    }
    fixture.harness.hub.recordHostOnlineRpcResponse({
      message: hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        requestId: storageDeleteRequest.requestId,
        commandType: "thread.storage.delete",
        ok: true,
        result: { providerCheckpointId: null },
      }),
      sessionId: fixture.session.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([]);
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "exited",
        session: expect.objectContaining({
          id: stored.id,
          closeReason: "thread-deleted",
          status: "exited",
        }),
      }),
    );
  });

  it("closes terminal sessions once the archived thread's undo grace expires", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    fixture.harness.hub.registerTerminalClient(stored.id, browserSocket);

    const response = await fixture.harness.app.request(
      `/api/v1/threads/${fixture.thread.id}/archive-all`,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: stored.id,
      }),
    ).toMatchObject({ closeReason: null, status: "running" });

    expireArchiveUndoGrace(fixture.harness.deps, fixture.thread.id);
    await runThreadLifecycleSweep(fixture.harness.deps);

    const closeMessage = await waitForDaemonMessage(fixture.socket);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "thread-archived",
    });
    expect(
      listTerminalSessionsByThread(fixture.harness.db, fixture.thread.id),
    ).toEqual([
      expect.objectContaining({
        id: stored.id,
        closeReason: "thread-archived",
        daemonSessionId: null,
        status: "exited",
      }),
    ]);
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "exited",
        session: expect.objectContaining({
          id: stored.id,
          closeReason: "thread-archived",
          status: "exited",
        }),
      }),
    );
  });

  it("serializes concurrent restarts and keeps the old terminal until replacement opens", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 30,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const restartRequest = () =>
      fixture.harness.app.request(`/api/v1/terminals/${stored.id}/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

    const firstResponsePromise = restartRequest();
    const secondResponsePromise = restartRequest();
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: stored.id,
      }),
    ).toMatchObject({ status: "running" });
    acknowledgeTerminalOpen(fixture, openMessage);

    const closeMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "user",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: stored.id,
        exitCode: 0,
        closeReason: "user",
      },
    });

    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const firstReplacement = terminalSessionSchema.parse(
      await readJson(firstResponse),
    );
    const secondReplacement = terminalSessionSchema.parse(
      await readJson(secondResponse),
    );
    expect(firstReplacement.id).toBe(openMessage.terminalId);
    expect(secondReplacement.id).toBe(openMessage.terminalId);
    expect(
      readDaemonOperationMessages(fixture.socket).filter(
        (message) => message.type === "terminal.open",
      ),
    ).toHaveLength(1);
  });

  it("preserves the old terminal when restart cannot open a replacement", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 100,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 30,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const responsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/restart`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const openMessage = await waitForDaemonMessage(fixture.socket);
    if (openMessage.type !== "terminal.open") {
      throw new Error(`Expected terminal.open, received ${openMessage.type}`);
    }
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.error",
        requestId: openMessage.requestId,
        terminalId: openMessage.terminalId,
        code: "terminal_open_failed",
        message: "spawn failed",
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(
      getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: stored.id,
      }),
    ).toMatchObject({ status: "running" });
    expect(
      readDaemonOperationMessages(fixture.socket).filter(
        (message) => message.type === "terminal.close",
      ),
    ).toEqual([]);
  });

  it("closes a clean terminal through the public route when if-clean mode is requested", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });

    const responsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "if-clean", reason: "user" }),
      },
    );

    const closeMessage = await waitForDaemonMessage(fixture.socket);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "user",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: stored.id,
        exitCode: 0,
        closeReason: "user",
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(terminalSessionSchema.parse(await readJson(response))).toMatchObject(
      {
        id: stored.id,
        closeReason: "user",
        status: "exited",
      },
    );
  });

  it("completes a terminal close when its daemon acknowledgement times out", async () => {
    const fixture = await createTerminalRouteFixture({
      terminalCloseTimeoutMs: 50,
    });
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "zsh",
    });

    const responsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );

    await expect(waitForDaemonMessage(fixture.socket)).resolves.toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "user",
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(terminalSessionSchema.parse(await readJson(response))).toMatchObject(
      {
        id: stored.id,
        closeReason: "user",
        exitCode: null,
        status: "exited",
      },
    );
    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        terminalId: stored.id,
        threadId: fixture.thread.id,
      }),
    ).toMatchObject({
      closeReason: "user",
      daemonSessionId: null,
      exitCode: null,
      status: "exited",
    });
  });

  it("keeps an undeliverable terminal close available for reconnect cleanup", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "zsh",
    });
    fixture.harness.hub.unregisterDaemon(fixture.session.id);

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );

    expect(response.status).toBe(502);
    expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
      code: "host_disconnected",
    });
    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        terminalId: stored.id,
        threadId: fixture.thread.id,
      }),
    ).toMatchObject({
      closeReason: null,
      daemonSessionId: fixture.session.id,
      status: "disconnected",
    });

    const replacementSession = seedSession(
      fixture.harness.deps,
      fixture.host.id,
      { instanceId: "instance-restarted" },
    );
    const replacementSocket = createFakeDaemonSocket();
    onDaemonSocketOpen(fixture.harness.deps, {
      hostId: fixture.host.id,
      sessionId: replacementSession.id,
      socket: replacementSocket,
    });

    expect(await waitForDaemonMessage(replacementSocket)).toEqual({
      type: "connect-shares.replace",
      generation: 0,
      ports: [],
    });
    await expect(
      waitForDaemonMessage(replacementSocket, 1),
    ).resolves.toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "daemon-disconnect",
    });
    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        terminalId: stored.id,
        threadId: fixture.thread.id,
      }),
    ).toMatchObject({
      closeReason: "daemon-disconnect",
      daemonSessionId: null,
      status: "exited",
    });
  });

  it("does not close a dirty terminal unless force mode is requested", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    markTerminalSessionUserInput(fixture.harness.db, {
      terminalId: stored.id,
      threadId: fixture.thread.id,
      now: 10,
    });

    const response = await fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "if-clean", reason: "user" }),
      },
    );

    expect(response.status).toBe(200);
    expect(terminalSessionSchema.parse(await readJson(response))).toMatchObject(
      {
        id: stored.id,
        lastUserInputAt: 10,
        status: "running",
      },
    );
    expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);

    const forceResponsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );

    const closeMessage = await waitForDaemonMessage(fixture.socket);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "user",
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: stored.id,
        exitCode: 0,
        closeReason: "user",
      },
    });

    const forceResponse = await forceResponsePromise;
    expect(forceResponse.status).toBe(200);
    expect(
      terminalSessionSchema.parse(await readJson(forceResponse)),
    ).toMatchObject({
      id: stored.id,
      closeReason: "user",
      lastUserInputAt: 10,
      status: "exited",
    });
  });

  it("applies the remaining browser's size after a newer attach fails", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const firstSocket = createFakeBrowserSocket();
    const secondSocket = createFakeBrowserSocket();

    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      terminalId: stored.id,
      socket: firstSocket,
      sinceSeq: 0,
    });
    const firstAttach = await waitForDaemonMessage(fixture.socket, 0);
    if (firstAttach.type !== "terminal.attach") {
      throw new Error(`Expected terminal.attach, received ${firstAttach.type}`);
    }
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: firstAttach.requestId,
        terminalId: stored.id,
        chunks: [],
        replayStartSeq: 0,
        nextSeq: 0,
      },
    });

    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      terminalId: stored.id,
      socket: secondSocket,
      sinceSeq: 0,
    });
    const secondAttach = await waitForDaemonMessage(fixture.socket, 1);
    if (secondAttach.type !== "terminal.attach") {
      throw new Error(
        `Expected terminal.attach, received ${secondAttach.type}`,
      );
    }
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.error",
        requestId: secondAttach.requestId,
        terminalId: stored.id,
        code: "terminal_attach_failed",
        message: "attach failed",
      },
    });

    fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: stored.id,
      socket: firstSocket,
      message: { type: "resize", cols: 120, rows: 40 },
    });

    expect(await waitForDaemonMessage(fixture.socket, 2)).toMatchObject({
      type: "terminal.resize",
      terminalId: stored.id,
      cols: 120,
      rows: 40,
    });
  });

  it("sizes the PTY to the smallest visible device so every screen renders it", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const terminals = fixture.harness.deps.terminalSessions;
    const desktop = createFakeBrowserSocket();
    const phone = createFakeBrowserSocket();
    const sizes = () =>
      readDaemonOperationMessages(fixture.socket).flatMap((message) =>
        message.type === "terminal.resize"
          ? [`${message.cols}x${message.rows}`]
          : [],
      );
    const send = (
      socket: FakeBrowserSocket,
      message: Parameters<
        typeof terminals.handleBrowserTerminalMessage
      >[0]["message"],
    ) =>
      terminals.handleBrowserTerminalMessage({
        terminalId: stored.id,
        socket,
        message,
      });

    const attach = async (socket: FakeBrowserSocket) => {
      const before = readDaemonOperationMessages(fixture.socket).length;
      terminals.attachBrowserTerminal({
        outputAcks: false,
        resizeAcks: false,
        terminalId: stored.id,
        socket,
        sinceSeq: 0,
      });
      const request = await waitForDaemonMessage(fixture.socket, before);
      if (request.type !== "terminal.attach") {
        throw new Error(`Expected terminal.attach, received ${request.type}`);
      }
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: request.requestId,
          terminalId: stored.id,
          chunks: [],
          replayStartSeq: 0,
          nextSeq: 0,
        },
      });
    };

    await attach(desktop);
    send(desktop, { type: "resize", cols: 160, rows: 48 });
    expect(sizes()).toEqual(["160x48"]);

    await attach(phone);
    send(phone, { type: "resize", cols: 44, rows: 30 });
    expect(sizes()).toEqual(["160x48", "44x30"]);
    send(phone, { type: "resize", cols: 44, rows: 20 });
    send(desktop, { type: "resize", cols: 150, rows: 48 });
    expect(sizes()).toEqual(["160x48", "44x30", "44x20"]);

    send(desktop, { type: "input", dataBase64: "YQ==" });
    send(phone, { type: "input", dataBase64: "YQ==" });
    send(desktop, { type: "resize", cols: 150, rows: 48, claim: true });
    expect(sizes()).toHaveLength(3);

    send(phone, { type: "visibility", visible: false });
    expect(sizes()).toEqual(["160x48", "44x30", "44x20", "150x48"]);
    send(phone, { type: "visibility", visible: true });
    expect(sizes()).toEqual(["160x48", "44x30", "44x20", "150x48", "44x20"]);
    send(desktop, { type: "ping" });
    send(desktop, { type: "resize", cols: 170, rows: 50 });
    send(desktop, { type: "resize", cols: 150, rows: 48 });
    send(phone, { type: "ping" });
    expect(sizes()).toHaveLength(5);
    expect(
      fixture.harness.deps.terminalSessions.getTerminal({
        terminalId: stored.id,
      }),
    ).toMatchObject({ cols: 44, rows: 20 });

    terminals.detachBrowserTerminal({ terminalId: stored.id, socket: phone });
    expect(sizes()).toEqual([
      "160x48",
      "44x30",
      "44x20",
      "150x48",
      "44x20",
      "150x48",
    ]);
    expect(
      fixture.harness.deps.terminalSessions.getTerminal({
        terminalId: stored.id,
      }),
    ).toMatchObject({ cols: 150, rows: 48 });

    const legacyCli = createFakeBrowserSocket();
    await attach(legacyCli);
    send(legacyCli, { type: "resize", cols: 80, rows: 24, claim: true });
    expect(sizes().at(-1)).toBe("80x24");
    const resizesBeforeIdle = sizes().length;

    const startedAt = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(startedAt + TERMINAL_CLIENT_STALE_MS * 3);
    try {
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: stored.id,
          chunk: {
            seq: 0,
            dataBase64: Buffer.from("still working\n").toString("base64"),
          },
        },
      });
      send(desktop, { type: "ping" });
      send(desktop, { type: "resize", cols: 151, rows: 48 });
      expect(sizes()).toHaveLength(resizesBeforeIdle);
      expect(
        fixture.harness.deps.terminalSessions.getTerminal({
          terminalId: stored.id,
        }),
      ).toMatchObject({ cols: 80, rows: 24 });
    } finally {
      clock.mockRestore();
    }
  });

  it("acknowledges each tagged resize after its session update, even when the shared size does not change, and only on sockets that asked", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const terminals = fixture.harness.deps.terminalSessions;
    const owner = createFakeBrowserSocket();
    const peer = createFakeBrowserSocket();
    const legacy = createFakeBrowserSocket();
    const send = (
      socket: FakeBrowserSocket,
      message: Parameters<
        typeof terminals.handleBrowserTerminalMessage
      >[0]["message"],
    ) =>
      terminals.handleBrowserTerminalMessage({
        terminalId: stored.id,
        socket,
        message,
      });
    const attach = async (socket: FakeBrowserSocket, resizeAcks: boolean) => {
      const before = readDaemonOperationMessages(fixture.socket).length;
      terminals.attachBrowserTerminal({
        outputAcks: false,
        resizeAcks,
        terminalId: stored.id,
        socket,
        sinceSeq: 0,
      });
      const request = await waitForDaemonMessage(fixture.socket, before);
      if (request.type !== "terminal.attach") {
        throw new Error(`Expected terminal.attach, received ${request.type}`);
      }
      terminals.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.replay",
          requestId: request.requestId,
          terminalId: stored.id,
          chunks: [],
          replayStartSeq: 0,
          nextSeq: 0,
        },
      });
    };
    const kinds = (socket: FakeBrowserSocket) =>
      readBrowserMessages(socket).flatMap((message) => {
        if (message.type === "session-updated") {
          return [`size ${message.session.cols}x${message.session.rows}`];
        }
        if (message.type === "resize-applied") {
          return [`applied ${message.seq}`];
        }
        if (message.type === "features") {
          return ["features"];
        }
        return [];
      });

    await attach(owner, true);
    await attach(peer, false);
    await attach(legacy, false);
    expect(kinds(owner)).toEqual(["features"]);
    expect(kinds(peer)).toEqual([]);

    send(owner, { type: "resize", cols: 60, rows: 20, seq: 1 });
    expect(kinds(owner)).toEqual(["features", "size 60x20", "applied 1"]);
    send(owner, { type: "resize", cols: 60, rows: 20, seq: 2 });
    expect(kinds(owner)).toEqual([
      "features",
      "size 60x20",
      "applied 1",
      "applied 2",
    ]);
    send(peer, { type: "resize", cols: 40, rows: 20 });
    send(peer, { type: "resize", cols: 30, rows: 10, seq: 7 });
    send(legacy, { type: "resize", cols: 50, rows: 12 });

    expect(kinds(owner)).toEqual([
      "features",
      "size 60x20",
      "applied 1",
      "applied 2",
      "size 40x20",
      "size 30x10",
    ]);
    expect(kinds(peer)).toEqual(["size 60x20", "size 40x20", "size 30x10"]);
  });

  it("paces the daemon by the output an acknowledging browser has parsed", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();
    const sendOutput = (seq: number) =>
      fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        message: {
          type: "terminal.output",
          terminalId: stored.id,
          chunk: {
            seq,
            dataBase64: Buffer.from(`line ${seq}\n`, "utf8").toString("base64"),
          },
        },
      });

    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: true,
      resizeAcks: false,
      terminalId: stored.id,
      socket: browserSocket,
      sinceSeq: 0,
    });
    const attachMessage = await waitForDaemonMessage(fixture.socket);
    if (attachMessage.type !== "terminal.attach") {
      throw new Error(
        `Expected terminal.attach, received ${attachMessage.type}`,
      );
    }
    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: attachMessage.requestId,
        terminalId: stored.id,
        chunks: [],
        replayStartSeq: 0,
        nextSeq: 0,
      },
    });

    sendOutput(0);
    sendOutput(1);
    sendOutput(2);
    fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: stored.id,
      socket: browserSocket,
      message: { type: "ack", nextSeq: 3 },
    });
    fixture.harness.deps.terminalSessions.detachBrowserTerminal({
      terminalId: stored.id,
      socket: browserSocket,
    });

    expect(readDaemonOperationMessages(fixture.socket).slice(1)).toEqual([
      { type: "terminal.flow-control", terminalId: stored.id, enabled: true },
      { type: "terminal.ack", terminalId: stored.id, nextSeq: 3 },
      { type: "terminal.flow-control", terminalId: stored.id, enabled: false },
    ]);
  });

  it("streams terminal traffic between browser sockets and the owning daemon", async () => {
    const fixture = await createTerminalRouteFixture();
    harnesses.push(fixture.harness);
    const stored = createTerminalSession(fixture.harness.db, {
      cols: 80,
      daemonSessionId: fixture.session.id,
      environmentId: fixture.environment.id,
      hostId: fixture.host.id,
      initialCwd: "/tmp/terminal-workspace",
      rows: 24,
      status: "running",
      threadId: fixture.thread.id,
      title: "Terminal 1",
    });
    const browserSocket = createFakeBrowserSocket();

    fixture.harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      terminalId: stored.id,
      socket: browserSocket,
      sinceSeq: 0,
    });
    const attachMessage = await waitForDaemonMessage(fixture.socket);
    if (attachMessage.type !== "terminal.attach") {
      throw new Error(
        `Expected terminal.attach, received ${attachMessage.type}`,
      );
    }
    expect(attachMessage).toMatchObject({
      terminalId: stored.id,
      sinceSeq: 0,
      tailBytes: 4 * 1024 * 1024,
    });

    const replayChunk = {
      seq: 0,
      dataBase64: Buffer.from("hello\n", "utf8").toString("base64"),
    };
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: stored.id,
        chunk: replayChunk,
      },
    });
    expect(readBrowserMessages(browserSocket)).toEqual([]);

    await fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.replay",
        requestId: attachMessage.requestId,
        terminalId: stored.id,
        chunks: [replayChunk],
        replayStartSeq: 0,
        nextSeq: 1,
      },
    });
    expect(readBrowserMessages(browserSocket)).toEqual([
      expect.objectContaining({
        type: "attached",
        replayStartSeq: 0,
        nextSeq: 1,
        session: expect.objectContaining({ id: stored.id }),
      }),
      { type: "output", chunk: replayChunk },
    ]);

    const liveChunk = {
      seq: 1,
      dataBase64: Buffer.from("world\n", "utf8").toString("base64"),
    };
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: stored.id,
        chunk: liveChunk,
      },
    });
    expect(readBrowserMessages(browserSocket)).toContainEqual({
      type: "output",
      chunk: liveChunk,
    });

    fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: stored.id,
      socket: browserSocket,
      message: {
        type: "input",
        dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
      },
    });
    const inputMessage = await waitForDaemonMessage(fixture.socket, 1);
    expect(inputMessage).toMatchObject({
      type: "terminal.input",
      terminalId: stored.id,
      dataBase64: Buffer.from("pwd\n", "utf8").toString("base64"),
    });
    expect(
      getTerminalSessionForThread(fixture.harness.db, {
        terminalId: stored.id,
        threadId: fixture.thread.id,
      })?.lastUserInputAt,
    ).toBeTypeOf("number");
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "session-updated",
        session: expect.objectContaining({
          id: stored.id,
          lastUserInputAt: expect.any(Number),
        }),
      }),
    );

    fixture.harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId: stored.id,
      socket: browserSocket,
      message: {
        type: "resize",
        cols: 120,
        rows: 40,
      },
    });
    const resizeMessage = await waitForDaemonMessage(fixture.socket, 2);
    expect(resizeMessage).toMatchObject({
      type: "terminal.resize",
      terminalId: stored.id,
      cols: 120,
      rows: 40,
    });
    expect(readBrowserMessages(browserSocket)).toContainEqual(
      expect.objectContaining({
        type: "session-updated",
        session: expect.objectContaining({
          id: stored.id,
          cols: 120,
          rows: 40,
        }),
      }),
    );

    const closeResponsePromise = fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );
    const closeMessage = await waitForDaemonMessage(fixture.socket, 3);
    expect(closeMessage).toMatchObject({
      type: "terminal.close",
      terminalId: stored.id,
      reason: "user",
    });
    const finalChunk = {
      seq: 2,
      dataBase64: Buffer.from("final output\n", "utf8").toString("base64"),
    };
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: stored.id,
        chunk: finalChunk,
      },
    });
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: stored.id,
        exitCode: 0,
        closeReason: "user",
      },
    });
    expect((await closeResponsePromise).status).toBe(200);
    const closingMessages = readBrowserMessages(browserSocket).slice(-2);
    expect(closingMessages).toEqual([
      { type: "output", chunk: finalChunk },
      expect.objectContaining({
        type: "exited",
        session: expect.objectContaining({
          id: stored.id,
          closeReason: "user",
          status: "exited",
        }),
      }),
    ]);
    const retainedOutputResponse = await fixture.harness.app.request(
      `/api/v1/terminals/${stored.id}/output?tailBytes=4096`,
    );
    expect(retainedOutputResponse.status).toBe(200);
    const retainedOutput = terminalOutputResponseSchema.parse(
      await retainedOutputResponse.json(),
    );
    expect(
      Buffer.concat(
        retainedOutput.chunks.map((chunk) =>
          Buffer.from(chunk.dataBase64, "base64"),
        ),
      ).toString("utf8"),
    ).toContain("hello\nworld\nfinal output\n");
    const retainedTerminalsResponse = await fixture.harness.app.request(
      `/api/v1/terminals?threadId=${fixture.thread.id}`,
    );
    expect(retainedTerminalsResponse.status).toBe(200);
    const retainedTerminals = terminalListResponseSchema.parse(
      await retainedTerminalsResponse.json(),
    );
    expect(retainedTerminals.sessions).toContainEqual(
      expect.objectContaining({ id: stored.id, status: "exited" }),
    );

    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.output",
        terminalId: stored.id,
        chunk: {
          seq: 3,
          dataBase64: Buffer.from("stale", "utf8").toString("base64"),
        },
      },
    });
    expect(readBrowserMessages(browserSocket).slice(-2)).toEqual(
      closingMessages,
    );
  });

  describe("direct daemon output", () => {
    async function createRunningTerminal() {
      const fixture = await createTerminalRouteFixture();
      harnesses.push(fixture.harness);
      const stored = createTerminalSession(fixture.harness.db, {
        cols: 80,
        daemonSessionId: fixture.session.id,
        environmentId: fixture.environment.id,
        hostId: fixture.host.id,
        initialCwd: "/tmp/terminal-workspace",
        rows: 24,
        status: "running",
        threadId: fixture.thread.id,
        title: "Terminal 1",
      });
      const terminalSessions = fixture.harness.deps.terminalSessions;
      const attach = async (
        socket: FakeBrowserSocket,
        args: { nextSeq: number; outputAcks: boolean },
      ) => {
        const before = readDaemonOperationMessages(fixture.socket).length;
        terminalSessions.attachBrowserTerminal({
          outputAcks: args.outputAcks,
          resizeAcks: false,
          terminalId: stored.id,
          socket,
          sinceSeq: args.nextSeq,
        });
        const attachMessage = await waitForDaemonMessage(
          fixture.socket,
          before,
        );
        if (attachMessage.type !== "terminal.attach") {
          throw new Error(
            `Expected terminal.attach, received ${attachMessage.type}`,
          );
        }
        terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: attachMessage.requestId,
            terminalId: stored.id,
            chunks: [],
            replayStartSeq: args.nextSeq,
            nextSeq: args.nextSeq,
          },
        });
      };
      const sendOutput = (seq: number) =>
        terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.output",
            terminalId: stored.id,
            chunk: {
              seq,
              dataBase64: Buffer.from(`line ${seq}\n`, "utf8").toString(
                "base64",
              ),
            },
          },
        });
      return { attach, fixture, sendOutput, stored, terminalSessions };
    }

    it("closes the browsers the server holds when a daemon session starts sending output directly, and releases their pacing", async () => {
      const { attach, fixture, sendOutput, stored, terminalSessions } =
        await createRunningTerminal();
      const browserSocket = createFakeBrowserSocket();
      await attach(browserSocket, { nextSeq: 0, outputAcks: true });
      sendOutput(0);
      sendOutput(1);
      expect(readBrowserMessages(browserSocket)).toEqual([
        expect.objectContaining({ type: "attached", nextSeq: 0 }),
        expect.objectContaining({ type: "output" }),
        expect.objectContaining({ type: "output" }),
      ]);

      terminalSessions.setDaemonSessionDirectOutput({
        daemonSessionId: fixture.session.id,
        enabled: true,
      });
      terminalSessions.setDaemonSessionDirectOutput({
        daemonSessionId: fixture.session.id,
        enabled: true,
      });

      expect(browserSocket.close).toHaveBeenCalledTimes(1);
      expect(browserSocket.close).toHaveBeenCalledWith(
        1013,
        "terminal-output-path-changed",
      );
      expect(
        readDaemonOperationMessages(fixture.socket).filter(
          (message) => message.type === "terminal.flow-control",
        ),
      ).toEqual([
        { type: "terminal.flow-control", terminalId: stored.id, enabled: true },
        {
          type: "terminal.flow-control",
          terminalId: stored.id,
          enabled: false,
        },
      ]);
    });

    it("refuses a browser on the wrong output path instead of leaving it without live output", async () => {
      const { attach, fixture, sendOutput, stored, terminalSessions } =
        await createRunningTerminal();
      terminalSessions.setDaemonSessionDirectOutput({
        daemonSessionId: fixture.session.id,
        enabled: true,
      });

      const heldByServer = createFakeBrowserSocket();
      await attach(heldByServer, { nextSeq: 0, outputAcks: false });
      expect(heldByServer.close).toHaveBeenCalledWith(
        1013,
        "terminal-output-path-changed",
      );
      expect(readBrowserMessages(heldByServer)).toEqual([]);

      const direct = createFakeBrowserSocket();
      terminalSessions.markDirectOutputSocket(direct);
      await attach(direct, { nextSeq: 0, outputAcks: true });
      expect(direct.close).not.toHaveBeenCalled();
      expect(readBrowserMessages(direct)).toEqual([
        expect.objectContaining({ type: "attached", nextSeq: 0 }),
      ]);
      expect(
        readDaemonOperationMessages(fixture.socket).filter(
          (message) => message.type === "terminal.flow-control",
        ),
      ).toEqual([]);

      terminalSessions.setDaemonSessionDirectOutput({
        daemonSessionId: fixture.session.id,
        enabled: false,
      });
      expect(direct.close).toHaveBeenCalledWith(
        1013,
        "terminal-output-path-changed",
      );
      terminalSessions.detachBrowserTerminal({
        terminalId: stored.id,
        socket: direct,
      });

      const lateDirect = createFakeBrowserSocket();
      terminalSessions.markDirectOutputSocket(lateDirect);
      await attach(lateDirect, { nextSeq: 0, outputAcks: false });
      expect(lateDirect.close).toHaveBeenCalledWith(
        1013,
        "terminal-output-path-changed",
      );

      const backOnServer = createFakeBrowserSocket();
      await attach(backOnServer, { nextSeq: 0, outputAcks: false });
      sendOutput(0);
      expect(backOnServer.close).not.toHaveBeenCalled();
      expect(readBrowserMessages(backOnServer)).toEqual([
        expect.objectContaining({ type: "attached", nextSeq: 0 }),
        expect.objectContaining({ type: "output" }),
      ]);
    });

    it("records typing that bypassed the server once per report", async () => {
      const { fixture, stored, terminalSessions } =
        await createRunningTerminal();
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: stored.id,
        })?.lastUserInputAt,
      ).toBeNull();

      terminalSessions.recordDirectTerminalInput(stored.id);
      const marked = getTerminalSession(fixture.harness.db, {
        kind: "terminal",
        terminalId: stored.id,
      });
      terminalSessions.recordDirectTerminalInput(stored.id);
      terminalSessions.recordDirectTerminalInput("term_missing");

      expect(marked?.lastUserInputAt).not.toBeNull();
      expect(
        getTerminalSession(fixture.harness.db, {
          kind: "terminal",
          terminalId: stored.id,
        })?.lastUserInputAt,
      ).toBe(marked?.lastUserInputAt);
      expect(readDaemonOperationMessages(fixture.socket)).toEqual([]);
    });
  });
});
