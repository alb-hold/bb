import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import {
  createConnection,
  createTerminalSession,
  getDeviceHandoffAttentionMarker,
  getTerminalAttention,
  getThread,
  hasActiveThreadAttention,
  updateThread,
  updateTerminalSession,
} from "@bb/db";
import {
  createDeviceHandoffIdentityManager,
  DEVICE_HANDOFF_CLIENT_TOKEN_HEADER,
  DEVICE_HANDOFF_DEVICE_STORAGE_KEY,
} from "@bb/server-contract";
import { turnScope } from "@bb/domain";
import { createNodeBbSdk } from "@bb/sdk/node";
import {
  createTestAppHarness,
  startTestServer,
  type TestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedEvent,
  seedTurnStarted,
} from "../helpers/seed.js";
import { getActiveTurnId } from "../../src/services/threads/thread-events.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../helpers/host-rpc.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

async function connectRealtime(
  baseUrl: string,
  options: { origin?: string; path?: string } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}${options.path ?? "/ws"}`,
    options.origin === undefined ? {} : { origin: options.origin },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function connectRealtimeWithToken(
  baseUrl: string,
  options: { origin?: string; path?: string; deviceId?: string } = {},
): Promise<{ socket: WebSocket; token: string }> {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}${options.path ?? "/ws"}`,
    options.origin === undefined ? {} : { origin: options.origin },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const token = nextRealtimeMessage(socket, "device-handoff-client-token");
  sendRealtime(socket, {
    type: "device-handoff-device",
    token: options.deviceId ?? null,
  });
  const signal = await token;
  return { socket, token: signal.token as string };
}

function rejectedRealtimeResponse(
  baseUrl: string,
  options: { origin?: string; host?: string },
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const headers = options.host === undefined ? {} : { host: options.host };
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      headers,
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.once("end", () => {
        resolve({ body, status: response.statusCode ?? 0 });
      });
    });
    socket.once("error", () => {});
  });
}

function statusWithRawHost(
  baseUrl: string,
  headers: Record<string, string>,
  path = "/health",
): Promise<{ body: string; status: number }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({ body, status: response.statusCode ?? 0 });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function rejectedRealtimeStatus(
  baseUrl: string,
  options: { origin?: string; host?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers = options.host === undefined ? {} : { host: options.host };
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      headers,
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status === undefined) {
        reject(new Error("WebSocket rejection omitted an HTTP status"));
        return;
      }
      resolve(status);
    });
    socket.once("error", () => {});
  });
}

function nextRealtimeMessage(
  socket: WebSocket,
  type?: string,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for realtime message"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (type !== undefined && parsed.type !== type) return;
      clearTimeout(timer);
      resolve(parsed);
    };
    socket.on("message", onMessage);
  });
}

function nextSocketMessage(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for terminal websocket ${type}`));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.type !== type) return;
      clearTimeout(timer);
      resolve(parsed);
    };
    socket.on("message", onMessage);
  });
}

function sendRealtime(
  socket: WebSocket,
  message: Record<string, unknown>,
): void {
  socket.send(JSON.stringify(message));
}

async function postThreadSend(
  server: Pick<TestAppHarness, "app">,
  args: {
    threadId: string;
    token: string;
    text: string;
    mode: "auto" | "steer";
  },
): Promise<Response> {
  return await server.app.request(`/api/v1/threads/${args.threadId}/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: args.token,
    },
    body: JSON.stringify({
      input: [{ type: "text", text: args.text }],
      mode: args.mode,
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    }),
  });
}

function recordThreadHandoffSubmitter(
  hub: TestAppHarness["hub"],
  threadId: string,
): ReturnType<typeof createMockHubSocket> {
  const socket = createMockHubSocket();
  const token = hub.issueDeviceHandoffClientToken(socket);
  expect(
    hub.recordDeviceHandoffTurnSubmitter(
      token,
      threadId,
      `test-request-${threadId}-${Math.random()}`,
    ),
  ).toBe(true);
  return socket;
}

async function connectLinkedTerminalAttachment(
  server: Awaited<ReturnType<typeof startTestServer>>,
  args: {
    hostId: string;
    sessionId: string;
    terminalId: string;
    ownerToken: string;
    visible: boolean;
  },
): Promise<{ setVisible(visible: boolean): Promise<void>; socket: WebSocket }> {
  let resolveDaemonAttach: ((frame: Record<string, unknown>) => void) | null =
    null;
  const daemonAttach = new Promise<Record<string, unknown>>((resolve) => {
    resolveDaemonAttach = resolve;
  });
  server.hub.registerDaemon(args.sessionId, args.hostId, {
    close() {},
    send(data) {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type === "terminal.attach") resolveDaemonAttach?.(frame);
    },
  });
  const socket = await connectRealtime(server.baseUrl, {
    path: `/ws/terminals/${args.terminalId}?sinceSeq=0&handoffOwnerToken=${encodeURIComponent(args.ownerToken)}`,
  });
  const attached = nextSocketMessage(socket, "attached");
  const attach = await daemonAttach;
  server.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: args.hostId,
    sessionId: args.sessionId,
    message: {
      type: "terminal.replay",
      requestId: attach.requestId as string,
      terminalId: args.terminalId,
      chunks: [],
      replayStartSeq: 0,
      nextSeq: 0,
    },
  });
  await attached;
  const setVisible = async (visible: boolean) => {
    sendRealtime(socket, { type: "visibility", visible });
    const pong = nextSocketMessage(socket, "pong");
    sendRealtime(socket, { type: "ping" });
    await pong;
  };
  await setVisible(args.visible);
  return { setVisible, socket };
}

async function expectNoRealtimeMessage(
  socket: WebSocket,
  type: string,
  durationMs = 100,
): Promise<void> {
  const received = await new Promise<boolean>((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(false);
    }, durationMs);
    socket.on("message", onMessage);
  });
  expect(received).toBe(false);
}

describe("device handoff route validation", () => {
  let harness: TestAppHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com"])(
    "rejects non-HTTP URL %s with a clear error",
    async (url) => {
      harness = await createTestAppHarness();
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url,
          origin: { threadId: "thr_example" },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("URL must use http or https");
    },
  );

  it("rejects text larger than 1 MiB by UTF-8 byte size", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "é".repeat(600_000),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("1 MiB limit");
  });

  it("rejects text larger than the schema character limit", async () => {
    harness = await createTestAppHarness();
    const response = await harness.app.request("/api/v1/device-handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "copy-text",
        text: "x".repeat(1_048_577),
        origin: { threadId: "thr_example" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid device handoff");
  });
});

describe("device handoff pending attention", () => {
  it("preserves an OSC-9 notification when the terminal exits", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        title: "OSC-9 exit terminal",
      });

      harness.deps.terminalSessions.notifyTerminal({
        terminalId: terminal.id,
        payload: { title: "Build done", body: "The build completed" },
      });
      const beforeExit = getTerminalAttention(harness.db, terminal.id);
      expect(beforeExit).toMatchObject({
        title: "Build done",
        body: "The build completed",
        clearedAt: null,
      });

      harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.exited",
          terminalId: terminal.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });

      expect(getTerminalAttention(harness.db, terminal.id)).toMatchObject({
        seq: beforeExit?.seq,
        title: "Build done",
        body: "The build completed",
        clearedAt: null,
      });
    });
  });

  it("preserves a newer OSC-9 notification when a handoff expires", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        title: "OSC-9 expiry terminal",
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "private handoff text",
            origin: { threadId: thread.id, terminalSessionId: terminal.id },
          }),
        });
        expect(response.status).toBe(200);

        harness.deps.terminalSessions.notifyTerminal({
          terminalId: terminal.id,
          payload: { title: "Deployment ready", body: "Version 42" },
        });
        const notification = getTerminalAttention(harness.db, terminal.id);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(getTerminalAttention(harness.db, terminal.id)).toMatchObject({
          seq: notification?.seq,
          title: "Deployment ready",
          body: "Version 42",
          clearedAt: null,
        });
        expect(
          getDeviceHandoffAttentionMarker(harness.db, terminal.id),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("clears terminal attention when its originating terminal exits", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        title: "Exiting handoff terminal",
      });
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "private copy text",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(
        getTerminalAttention(harness.db, terminal.id)?.clearedAt,
      ).toBeNull();
      expect(getDeviceHandoffAttentionMarker(harness.db, terminal.id)).toEqual({
        terminalSessionId: terminal.id,
        attentionSeq: 1,
      });

      harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.exited",
          terminalId: terminal.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });

      expect(
        getTerminalAttention(harness.db, terminal.id)?.clearedAt,
      ).not.toBeNull();
      expect(
        getDeviceHandoffAttentionMarker(harness.db, terminal.id),
      ).toBeNull();
      expect(
        harness.deps.terminalSessions.getTerminal({ terminalId: terminal.id })
          .attention,
      ).toBeNull();
    });
  });

  it("clears terminal attention when an undelivered handoff expires after exit", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        title: "Expired handoff terminal",
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "private expiring text",
            origin: { threadId: thread.id, terminalSessionId: terminal.id },
          }),
        });
        expect(response.status).toBe(200);
        updateTerminalSession(harness.db, {
          scope: { kind: "terminal", terminalId: terminal.id },
          update: {
            kind: "exit",
            closeReason: "process-exit",
            exitCode: 0,
          },
        });

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(
          getTerminalAttention(harness.db, terminal.id)?.clearedAt,
        ).not.toBeNull();
        expect(
          getDeviceHandoffAttentionMarker(harness.db, terminal.id),
        ).toBeNull();
        expect(
          harness.deps.terminalSessions.getTerminal({ terminalId: terminal.id })
            .attention,
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("raises fixed, payload-free terminal attention and clears it on delivery", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
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
        title: "Handoff terminal",
      });
      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/private-code",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(getTerminalAttention(harness.db, terminal.id)).toMatchObject({
        body: "",
        kind: "osc-9",
        title: "Link waiting for this device",
        clearedAt: null,
      });
      expect(
        JSON.stringify(getTerminalAttention(harness.db, terminal.id)),
      ).not.toContain("private-code");

      const viewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      const ownerToken = harness.hub.issueDeviceHandoffClientToken(viewer);
      const terminalAttachment = { close() {}, send() {} };
      harness.hub.registerTerminalClient(terminal.id, terminalAttachment);
      expect(
        harness.hub.linkDeviceHandoffTerminalAttachment(
          ownerToken,
          terminal.id,
          terminalAttachment,
        ),
      ).toBe(true);
      harness.hub.recordTerminalClientVisibility(
        terminal.id,
        terminalAttachment,
        true,
        Date.now(),
      );
      harness.hub.subscribe(viewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });
      harness.hub.setDeviceHandoffView(viewer, thread.id, terminal.id);
      const handoff = viewer.messages
        .map((message) => JSON.parse(message) as { id?: string; type?: string })
        .find((message) => message.type === "device-handoff");
      expect(handoff?.id).toBeDefined();
      harness.hub.acknowledgeDeviceHandoff(viewer, handoff!.id!);

      expect(
        getTerminalAttention(harness.db, terminal.id)?.clearedAt,
      ).not.toBeNull();
      expect(
        getDeviceHandoffAttentionMarker(harness.db, terminal.id),
      ).toBeNull();
      expect(
        viewer.messages.some((message) =>
          message.includes("device-handoff-expired"),
        ),
      ).toBe(false);
    });
  });

  it("queues a payload-free expiry notice for the originating thread only", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const { thread: unrelatedThread } = seedThreadFixture(harness);
      const submitter = recordThreadHandoffSubmitter(harness.hub, thread.id);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "private expired text",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        const unrelated = {
          messages: [] as string[],
          close() {},
          send(data: string) {
            this.messages.push(data);
          },
        };
        harness.hub.subscribe(unrelated, {
          kind: "thread-detail",
          threadId: unrelatedThread.id,
        });

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        const originViewer = submitter;
        harness.hub.subscribe(originViewer, {
          kind: "thread-detail",
          threadId: thread.id,
        });
        harness.hub.setDeviceHandoffView(originViewer, thread.id);

        const notice = originViewer.messages.find((message) =>
          message.includes("device-handoff-expired"),
        );
        expect(notice).toBeDefined();
        expect(Object.keys(JSON.parse(notice!)).sort()).toEqual([
          "id",
          "terminalSessionId",
          "threadId",
          "type",
        ]);
        expect(notice).not.toContain("private expired text");
        expect(unrelated.messages.join("\n")).not.toContain(
          "device-handoff-expired",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("marks a thread unread without including fallback handoff payloads", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Pending handoff source" },
      });
      const { thread: unrelatedThread } = seedThreadFixture(harness, {
        thread: { title: "Unrelated thread" },
      });
      const submitter = recordThreadHandoffSubmitter(harness.hub, thread.id);
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      updateThread(harness.db, harness.hub, unrelatedThread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      const unrelatedViewer = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(unrelatedViewer, {
        kind: "thread-detail",
        threadId: unrelatedThread.id,
      });
      const attentionObserver = {
        messages: [] as string[],
        close() {},
        send(data: string) {
          this.messages.push(data);
        },
      };
      harness.hub.subscribe(attentionObserver, { kind: "thread-list" });

      const response = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "private copy payload",
          origin: { threadId: thread.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      const urlResponse = await harness.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://login.example.com/device?code=private-url",
          origin: { threadId: thread.id },
        }),
      });
      expect(urlResponse.status).toBe(200);
      expect(await urlResponse.json()).toEqual({ delivered: 0 });
      expect(
        getThread(harness.db, thread.id)?.latestAttentionAt,
      ).toBeGreaterThan(1);
      const markerAt = getThread(harness.db, thread.id)?.latestAttentionAt;
      expect(getThread(harness.db, unrelatedThread.id)?.latestAttentionAt).toBe(
        1,
      );
      expect(hasActiveThreadAttention(harness.db)).toBe(true);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(
        attentionObserver.messages.some((message) =>
          message.includes(thread.id),
        ),
      ).toBe(true);
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );

      const originViewer = submitter;
      harness.hub.subscribe(originViewer, {
        kind: "thread-detail",
        threadId: thread.id,
      });
      harness.hub.setDeviceHandoffView(originViewer, thread.id);

      const handoffMessages = originViewer.messages.filter(
        (message) => JSON.parse(message).type === "device-handoff",
      );
      expect(handoffMessages).toHaveLength(2);
      expect(handoffMessages.join("\n")).toContain("private copy payload");
      expect(handoffMessages.join("\n")).toContain("private-url");
      expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(
        markerAt,
      );
      expect(markerAt).toBeGreaterThan(1);
      expect(unrelatedViewer.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private copy payload",
      );
      expect(attentionObserver.messages.join("\n")).not.toContain(
        "private-url",
      );
    });
  });

  it("clears its attention marker when an undelivered handoff expires", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { title: "Expiring handoff source" },
      });
      recordThreadHandoffSubmitter(harness.hub, thread.id);
      updateThread(harness.db, harness.hub, thread.id, {
        lastReadAt: 1,
        latestAttentionAt: 1,
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now());
        const response = await harness.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "expire me",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(200);
        expect(
          getThread(harness.db, thread.id)?.latestAttentionAt,
        ).toBeGreaterThan(1);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(getThread(harness.db, thread.id)?.latestAttentionAt).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("device handoff websocket acknowledgement", () => {
  it("delivers a thread-and-terminal handoff only through its linked visible attachment", async () => {
    const server = await startTestServer();
    const { host, session, thread } = seedThreadFixture(server);
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Mixed origin routing terminal",
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const { socket: viewer, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const forgedBoth = await connectRealtime(server.baseUrl, { origin });
    const forgedThreadOnly = await connectRealtime(server.baseUrl, { origin });
    const terminalAttachment = await connectLinkedTerminalAttachment(server, {
      hostId: host.id,
      sessionId: session.id,
      terminalId: terminal.id,
      ownerToken: token,
      visible: true,
    });
    const setView = async (
      socket: WebSocket,
      terminalSessionId: string | null,
    ) => {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId,
      });
      const pong = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await pong;
    };
    let viewerHandoffFrames = 0;
    const countViewerHandoffs = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "device-handoff") viewerHandoffFrames += 1;
    };

    try {
      await setView(viewer, terminal.id);
      await setView(forgedBoth, terminal.id);
      await setView(forgedThreadOnly, null);

      viewer.on("message", countViewerHandoffs);
      const received = nextRealtimeMessage(viewer, "device-handoff");
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "mixed thread and terminal payload",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 1 });
      const first = await received;
      expect(first).toMatchObject({
        type: "device-handoff",
        request: { text: "mixed thread and terminal payload" },
      });

      await setView(viewer, terminal.id);
      expect(viewerHandoffFrames).toBe(1);
      await expectNoRealtimeMessage(forgedBoth, "device-handoff");
      await expectNoRealtimeMessage(forgedThreadOnly, "device-handoff");
    } finally {
      viewer.off("message", countViewerHandoffs);
      viewer.close();
      forgedBoth.close();
      forgedThreadOnly.close();
      terminalAttachment.socket.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("delivers a pending mixed-origin handoff only when its viewer attachment becomes visible", async () => {
    const server = await startTestServer();
    const { host, session, thread } = seedThreadFixture(server);
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Pending mixed origin terminal",
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const { socket: viewer, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const forgedBoth = await connectRealtime(server.baseUrl, { origin });
    const forgedThreadOnly = await connectRealtime(server.baseUrl, { origin });
    const terminalAttachment = await connectLinkedTerminalAttachment(server, {
      hostId: host.id,
      sessionId: session.id,
      terminalId: terminal.id,
      ownerToken: token,
      visible: false,
    });
    const setView = async (
      socket: WebSocket,
      terminalSessionId: string | null,
    ) => {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId,
      });
      const pong = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await pong;
    };

    try {
      await setView(viewer, terminal.id);
      await setView(forgedBoth, terminal.id);
      await setView(forgedThreadOnly, null);
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "pending mixed-origin payload",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      await expectNoRealtimeMessage(forgedBoth, "device-handoff");
      await expectNoRealtimeMessage(forgedThreadOnly, "device-handoff");

      const received = nextRealtimeMessage(viewer, "device-handoff");
      await terminalAttachment.setVisible(true);
      expect(await received).toMatchObject({
        type: "device-handoff",
        request: { text: "pending mixed-origin payload" },
      });
      await expectNoRealtimeMessage(forgedBoth, "device-handoff");
      await expectNoRealtimeMessage(forgedThreadOnly, "device-handoff");
    } finally {
      viewer.close();
      forgedBoth.close();
      forgedThreadOnly.close();
      terminalAttachment.socket.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("routes an expired mixed-origin notice only through its linked visible attachment", async () => {
    const server = await startTestServer();
    const { host, session, thread } = seedThreadFixture(server);
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Expiring mixed origin terminal",
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const { socket: viewer, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const forgedBoth = await connectRealtime(server.baseUrl, { origin });
    const forgedThreadOnly = await connectRealtime(server.baseUrl, { origin });
    const terminalAttachment = await connectLinkedTerminalAttachment(server, {
      hostId: host.id,
      sessionId: session.id,
      terminalId: terminal.id,
      ownerToken: token,
      visible: false,
    });
    const setView = async (
      socket: WebSocket,
      terminalSessionId: string | null,
    ) => {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId,
      });
      const pong = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await pong;
    };

    try {
      await setView(viewer, terminal.id);
      await setView(forgedBoth, terminal.id);
      await setView(forgedThreadOnly, null);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://example.com/mixed-expiry",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      vi.useRealTimers();

      await setView(forgedBoth, terminal.id);
      await setView(forgedThreadOnly, null);
      await expectNoRealtimeMessage(forgedBoth, "device-handoff-expired");
      await expectNoRealtimeMessage(forgedThreadOnly, "device-handoff-expired");

      const expired = nextRealtimeMessage(viewer, "device-handoff-expired");
      await terminalAttachment.setVisible(true);
      expect(await expired).toMatchObject({
        type: "device-handoff-expired",
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });
      await expectNoRealtimeMessage(forgedBoth, "device-handoff-expired");
      await expectNoRealtimeMessage(forgedThreadOnly, "device-handoff-expired");
    } finally {
      vi.useRealTimers();
      viewer.close();
      forgedBoth.close();
      forgedThreadOnly.close();
      terminalAttachment.socket.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("delivers a terminal handoff after the command exits", async () => {
    const server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const { project } = seedProjectWithSource(server.deps, {
      hostId: host.id,
    });
    const thread = seedThread(server.deps, { projectId: project.id });
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Immediate exit handoff",
    });
    const { socket, token } = await connectRealtimeWithToken(server.baseUrl);
    const terminalAttachment = await connectLinkedTerminalAttachment(server, {
      hostId: host.id,
      sessionId: session.id,
      terminalId: terminal.id,
      ownerToken: token,
      visible: true,
    });
    try {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await ready;

      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://example.com/immediate-exit",
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });

      server.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.exited",
          terminalId: terminal.id,
          exitCode: 0,
          closeReason: "process-exit",
        },
      });

      const pending = nextRealtimeMessage(socket, "device-handoff");
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });
      expect(await pending).toMatchObject({
        type: "device-handoff",
        request: {
          kind: "open-url",
          url: "https://example.com/immediate-exit",
        },
      });
    } finally {
      socket.close();
      terminalAttachment.socket.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("rejects guarded upgrades and delivers a queued handoff to an admitted viewer", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const port = new URL(server.baseUrl).port;

    try {
      await expect(
        rejectedRealtimeStatus(server.baseUrl, {
          origin: "https://untrusted.example",
        }),
      ).resolves.toBe(403);
      await expect(
        rejectedRealtimeStatus(server.baseUrl, {
          host: `untrusted.example:${port}`,
        }),
      ).resolves.toBe(403);

      const admitted = await connectRealtime(server.baseUrl);
      try {
        sendRealtime(admitted, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(admitted, {
          type: "device-handoff-view",
          threadId: null,
          terminalSessionId: null,
        });
        const hiddenViewReady = nextRealtimeMessage(admitted, "pong");
        sendRealtime(admitted, { type: "ping" });
        await hiddenViewReady;

        const response = await server.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "queued for admitted viewer",
            origin: { threadId: thread.id },
          }),
        });
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toMatchObject({ code: "device_handoff_no_recipient" });
        expect(JSON.stringify(body)).toContain(
          "No device has sent a message in this thread yet",
        );
      } finally {
        admitted.close();
      }
    } finally {
      await server.close();
    }
  });

  it("keeps handoffs inside the existing WebSocket Host and Origin request boundary", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const port = new URL(server.baseUrl).port;
    const foreignHost = await rejectedRealtimeResponse(server.baseUrl, {
      host: `evil.example:${port}`,
    });
    expect(foreignHost.status).toBe(403);
    const hostGuardResponse = await statusWithRawHost(server.baseUrl, {
      host: `evil.example:${port}`,
    });
    expect(hostGuardResponse.status).toBe(403);
    expect(JSON.parse(hostGuardResponse.body)).toMatchObject({
      code: "forbidden_host",
    });

    const foreignOrigin = await rejectedRealtimeResponse(server.baseUrl, {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
    });
    expect(foreignOrigin.status).toBe(403);
    const originGuardResponse = await statusWithRawHost(
      server.baseUrl,
      {
        host: `127.0.0.1:${port}`,
        origin: "https://evil.example",
      },
      "/api/v1/threads",
    );
    expect(originGuardResponse.status).toBe(403);
    expect(JSON.parse(originGuardResponse.body)).toMatchObject({
      code: "forbidden_origin",
    });

    const { socket: admitted, token } = await connectRealtimeWithToken(
      server.baseUrl,
      {
        origin: `http://127.0.0.1:${port}`,
      },
    );
    try {
      sendRealtime(admitted, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(admitted, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          token,
          thread.id,
          "origin-request",
        ),
      ).toBe(true);
      const received = nextRealtimeMessage(admitted, "device-handoff");
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "only admitted viewers receive this",
          origin: { threadId: thread.id },
        }),
      });
      expect(response.status).toBe(200);
      await expect(received).resolves.toMatchObject({
        type: "device-handoff",
        request: {
          kind: "copy-text",
          text: "only admitted viewers receive this",
        },
      });
    } finally {
      admitted.close();
      await server.close();
    }
  });

  it("sends thread-only handoffs only to the submitting device despite forged view claims", async () => {
    const server = await startTestServer();
    const { thread: originThread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const { socket: viewer, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const subscribedElsewhere = await connectRealtime(server.baseUrl, {
      origin,
    });
    const viewingWithoutSubscription = await connectRealtime(server.baseUrl, {
      origin,
    });
    let viewerHandoffCount = 0;
    const countViewerHandoff = (data: WebSocket.RawData) => {
      if (
        (JSON.parse(data.toString()) as { type?: string }).type ===
        "device-handoff"
      ) {
        viewerHandoffCount += 1;
      }
    };
    viewer.on("message", countViewerHandoff);
    try {
      sendRealtime(viewer, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: originThread.id },
      });
      sendRealtime(viewer, {
        type: "device-handoff-view",
        threadId: originThread.id,
        terminalSessionId: null,
      });
      sendRealtime(subscribedElsewhere, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: originThread.id },
      });
      sendRealtime(subscribedElsewhere, {
        type: "device-handoff-view",
        threadId: originThread.id,
        terminalSessionId: null,
      });
      sendRealtime(viewingWithoutSubscription, {
        type: "device-handoff-view",
        threadId: originThread.id,
        terminalSessionId: null,
      });
      const viewerReady = nextRealtimeMessage(viewer, "pong");
      const elsewhereReady = nextRealtimeMessage(subscribedElsewhere, "pong");
      const unsubscribedReady = nextRealtimeMessage(
        viewingWithoutSubscription,
        "pong",
      );
      sendRealtime(viewer, { type: "ping" });
      sendRealtime(subscribedElsewhere, { type: "ping" });
      sendRealtime(viewingWithoutSubscription, { type: "ping" });
      await Promise.all([viewerReady, elsewhereReady, unsubscribedReady]);

      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          token,
          originThread.id,
          "view-bound-request",
        ),
      ).toBe(true);
      const received = nextRealtimeMessage(viewer, "device-handoff");
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "thread-only origin payload",
          origin: { threadId: originThread.id },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 1 });
      await expect(received).resolves.toMatchObject({
        type: "device-handoff",
        request: { kind: "copy-text", text: "thread-only origin payload" },
      });
      expect(viewerHandoffCount).toBe(1);
      await expectNoRealtimeMessage(subscribedElsewhere, "device-handoff");
      await expectNoRealtimeMessage(
        subscribedElsewhere,
        "device-handoff-expired",
      );
      await expectNoRealtimeMessage(
        viewingWithoutSubscription,
        "device-handoff",
      );
      await expectNoRealtimeMessage(
        viewingWithoutSubscription,
        "device-handoff-expired",
      );
    } finally {
      viewer.off("message", countViewerHandoff);
      viewer.close();
      subscribedElsewhere.close();
      viewingWithoutSubscription.close();
      await server.close();
    }
  });

  it("exposes no more through a handoff than an admitted terminal-output reader can read", async () => {
    const server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const { project } = seedProjectWithSource(server.deps, { hostId: host.id });
    const thread = seedThread(server.deps, { projectId: project.id });
    const payload = "same data in terminal output and device handoff";
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Handoff boundary terminal",
    });
    let resolveDaemonAttach:
      | ((message: Record<string, unknown>) => void)
      | null = null;
    const daemonAttach = new Promise<Record<string, unknown>>((resolve) => {
      resolveDaemonAttach = resolve;
    });
    server.hub.registerDaemon(session.id, host.id, {
      close() {},
      send(data) {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.type === "terminal.attach") resolveDaemonAttach?.(frame);
      },
    });
    const port = new URL(server.baseUrl).port;
    const origin = `http://127.0.0.1:${port}`;
    const { socket: viewer, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const terminalReader = await connectRealtime(server.baseUrl, {
      origin,
      path: `/ws/terminals/${terminal.id}?sinceSeq=0&handoffOwnerToken=${encodeURIComponent(token)}`,
    });
    try {
      sendRealtime(viewer, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(viewer, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });
      const handoff = nextRealtimeMessage(viewer, "device-handoff");
      const terminalOutput = nextSocketMessage(terminalReader, "output");
      const attach = await daemonAttach;
      expect(attach).toMatchObject({
        type: "terminal.attach",
        terminalId: terminal.id,
        sinceSeq: 0,
      });
      server.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.replay",
          requestId: attach.requestId as string,
          terminalId: terminal.id,
          chunks: [
            {
              seq: 0,
              dataBase64: Buffer.from(`${payload}\n`).toString("base64"),
            },
          ],
          replayStartSeq: 0,
          nextSeq: 1,
        },
      });
      sendRealtime(terminalReader, { type: "visibility", visible: true });
      const terminalPong = nextSocketMessage(terminalReader, "pong");
      sendRealtime(terminalReader, { type: "ping" });
      await terminalPong;
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: payload,
          origin: { threadId: thread.id, terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      await expect(handoff).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: payload },
      });
      const output = await terminalOutput;
      expect(output.type).toBe("output");
      expect(
        Buffer.from(
          (output.chunk as { dataBase64: string }).dataBase64,
          "base64",
        ).toString(),
      ).toContain(payload);
    } finally {
      viewer.close();
      terminalReader.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("delivers a pending shell handoff to the submitting device after reconnect", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const { socket: submitter, token } = await connectRealtimeWithToken(
      server.baseUrl,
      { origin },
    );
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    try {
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          token,
          thread.id,
          "shell-turn-request",
        ),
      ).toBe(true);
      sendRealtime(submitter, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(submitter, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      sendRealtime(forged.socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const submitterReady = nextRealtimeMessage(submitter, "pong");
      const forgedReady = nextRealtimeMessage(forged.socket, "pong");
      sendRealtime(submitter, { type: "ping" });
      sendRealtime(forged.socket, { type: "ping" });
      await Promise.all([submitterReady, forgedReady]);
      submitter.close();
      await new Promise<void>((resolve) =>
        submitter.once("close", () => resolve()),
      );

      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "pending until same device returns",
          origin: { threadId: thread.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      await expectNoRealtimeMessage(forged.socket, "device-handoff");

      const reconnected = await connectRealtimeWithToken(server.baseUrl, {
        origin,
        deviceId: token,
      });
      try {
        sendRealtime(reconnected.socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(reconnected.socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        await expect(
          nextRealtimeMessage(reconnected.socket, "device-handoff"),
        ).resolves.toMatchObject({
          request: { text: "pending until same device returns" },
        });
        await expectNoRealtimeMessage(forged.socket, "device-handoff");
      } finally {
        reconnected.socket.close();
      }
    } finally {
      forged.socket.close();
      await server.close();
    }
  });

  it("delivers and expires an unacknowledged handoff only on its bound device", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const { socket, token } = await connectRealtimeWithToken(server.baseUrl);
    try {
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          token,
          thread.id,
          "expiring-turn-request",
        ),
      ).toBe(true);
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://private.example/expiring-code",
          origin: { threadId: thread.id },
        }),
      });
      const queuedHandoff = nextRealtimeMessage(socket, "device-handoff");
      expect(response.status).toBe(200);
      const queued = await queuedHandoff;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const notice = nextRealtimeMessage(socket, "device-handoff-expired");
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const expired = await notice;
      expect(expired).toMatchObject({
        type: "device-handoff-expired",
        id: queued.id,
        threadId: thread.id,
      });
      expect(Object.keys(expired).sort()).toEqual([
        "id",
        "terminalSessionId",
        "threadId",
        "type",
      ]);
      expect(JSON.stringify(expired)).not.toContain("expiring-code");
    } finally {
      vi.useRealTimers();
      socket.close();
      await server.close();
    }
  });

  it("delivers a threadless terminal expiry notice only after that terminal is opened", async () => {
    const server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: null,
      title: "Standalone handoff terminal",
    });
    const socket = createMockHubSocket();
    const forged = createMockHubSocket();
    const token = server.hub.issueDeviceHandoffClientToken(socket);
    server.hub.issueDeviceHandoffClientToken(forged);
    try {
      server.hub.setDeviceHandoffView(socket, null, null);
      server.hub.setDeviceHandoffView(forged, null, terminal.id);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "private terminal-only copy",
          origin: { terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      vi.useRealTimers();

      const terminalViewer = { close() {}, send() {} };
      server.hub.registerTerminalClient(terminal.id, terminalViewer);
      server.hub.linkDeviceHandoffTerminalAttachment(
        token,
        terminal.id,
        terminalViewer,
      );
      server.hub.recordTerminalClientVisibility(
        terminal.id,
        terminalViewer,
        true,
        Date.now(),
      );
      server.hub.setDeviceHandoffView(socket, null, terminal.id);
      const expired = socket.messages
        .map((message) => JSON.parse(message))
        .find((message) => message.type === "device-handoff-expired");
      expect(expired).toMatchObject({
        threadId: null,
        terminalSessionId: terminal.id,
      });
      expect(JSON.stringify(expired)).not.toContain(
        "private terminal-only copy",
      );
      expect(
        forged.messages.map((message) => JSON.parse(message)),
      ).not.toContainEqual(
        expect.objectContaining({ type: "device-handoff-expired" }),
      );
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it("delivers a threadless handoff only to the app socket linked to its visible terminal attachment", async () => {
    const server = await startTestServer();
    const { host, session } = seedHostSession(server.deps);
    const terminal = createTerminalSession(server.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: null,
      title: "Standalone routing terminal",
    });
    const port = new URL(server.baseUrl).port;
    const origin = `http://127.0.0.1:${port}`;
    const { socket, token } = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const { socket: forged } = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const linkedAttachment = vi.spyOn(
      server.hub,
      "linkDeviceHandoffTerminalAttachment",
    );
    let resolveDaemonAttach: ((frame: Record<string, unknown>) => void) | null =
      null;
    const daemonAttach = new Promise<Record<string, unknown>>((resolve) => {
      resolveDaemonAttach = resolve;
    });
    server.hub.registerDaemon(session.id, host.id, {
      close() {},
      send(data) {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame.type === "terminal.attach") resolveDaemonAttach?.(frame);
      },
    });
    const terminalReader = await connectRealtime(server.baseUrl, {
      origin,
      path: `/ws/terminals/${terminal.id}?sinceSeq=0&handoffOwnerToken=${encodeURIComponent(token)}`,
    });
    try {
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: terminal.id,
      });
      sendRealtime(forged, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: terminal.id,
      });
      const attached = nextSocketMessage(terminalReader, "attached");
      const attach = await daemonAttach;
      expect(attach).not.toHaveProperty("handoffOwnerToken");
      server.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.replay",
          requestId: attach.requestId as string,
          terminalId: terminal.id,
          chunks: [],
          replayStartSeq: 0,
          nextSeq: 0,
        },
      });
      await attached;
      sendRealtime(terminalReader, { type: "visibility", visible: true });
      const terminalPong = nextSocketMessage(terminalReader, "pong");
      sendRealtime(terminalReader, { type: "ping" });
      await terminalPong;
      expect(linkedAttachment).toHaveBeenCalledTimes(1);
      expect(linkedAttachment.mock.results[0]?.value).toBe(true);
      const delivered = nextRealtimeMessage(socket, "device-handoff");
      const forgedFrame = nextRealtimeMessage(forged, "device-handoff");
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "standalone terminal payload",
          origin: { terminalSessionId: terminal.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 1 });
      expect(await delivered).toMatchObject({
        type: "device-handoff",
        request: {
          kind: "copy-text",
          text: "standalone terminal payload",
        },
      });
      await expect(
        Promise.race([
          forgedFrame,
          new Promise((resolve) => setTimeout(() => resolve("no-frame"), 100)),
        ]),
      ).resolves.toBe("no-frame");
      terminalReader.close();
      await new Promise<void>((resolve) =>
        terminalReader.once("close", () => resolve()),
      );
      const secondResponse = await server.app.request(
        "/api/v1/device-handoff",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "after detach",
            origin: { terminalSessionId: terminal.id },
          }),
        },
      );
      expect(await secondResponse.json()).toEqual({ delivered: 0 });
    } finally {
      socket.close();
      forged.close();
      terminalReader.close();
      server.hub.unregisterDaemon(session.id);
      await server.close();
    }
  });

  it("accepts an acknowledgement only from a socket that received the handoff", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const showing = await connectRealtimeWithToken(server.baseUrl);
    const elsewhere = await connectRealtimeWithToken(server.baseUrl);
    try {
      for (const socket of [showing.socket, elsewhere.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
      }
      sendRealtime(showing.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      sendRealtime(elsewhere.socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      });
      const showingReady = nextRealtimeMessage(showing.socket, "pong");
      sendRealtime(showing.socket, { type: "ping" });
      const elsewhereReady = nextRealtimeMessage(elsewhere.socket, "pong");
      sendRealtime(elsewhere.socket, { type: "ping" });
      await Promise.all([showingReady, elsewhereReady]);
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          showing.token,
          thread.id,
          "ack-test-turn",
        ),
      ).toBe(true);
      const baselineAttentionAt = getThread(
        server.db,
        thread.id,
      )?.latestAttentionAt;
      const delivered = server.hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "only the shown socket can acknowledge",
          origin: { threadId: thread.id, turnId: "ack-test-turn" },
        },
        thread.title ?? "Thread",
        thread.id,
        "ack-test-turn",
      );
      expect(delivered).toBe(1);
      const raisedAttentionAt = getThread(
        server.db,
        thread.id,
      )?.latestAttentionAt;
      expect(raisedAttentionAt).toBeGreaterThan(baselineAttentionAt!);
      const signal = await nextRealtimeMessage(
        showing.socket,
        "device-handoff",
      );
      expect(signal.type).toBe("device-handoff");

      sendRealtime(elsewhere.socket, {
        type: "device-handoff-ack",
        id: signal.id as string,
      });
      const elsewherePong = nextRealtimeMessage(elsewhere.socket, "pong");
      sendRealtime(elsewhere.socket, { type: "ping" });
      await elsewherePong;
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBe(
        raisedAttentionAt,
      );

      sendRealtime(showing.socket, {
        type: "device-handoff-ack",
        id: signal.id as string,
      });
      const showingPong = nextRealtimeMessage(showing.socket, "pong");
      sendRealtime(showing.socket, { type: "ping" });
      await showingPong;
      expect(getThread(server.db, thread.id)?.latestAttentionAt).toBeLessThan(
        raisedAttentionAt!,
      );
    } finally {
      showing.socket.close();
      elsewhere.socket.close();
      await server.close();
    }
  });

  it("binds a turn route header to its real app socket before dispatch", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-bound-submission",
      threadId: thread.id,
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-bound-submission",
      threadId: thread.id,
      turnId: "turn-bound-submission",
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const submitter = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    try {
      for (const socket of [submitter.socket, forged.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }
      const sendResponse = await server.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: submitter.token,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Steer from this app socket" }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      await expect(sendResponse.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      expect(
        rpc.requests.some(({ command }) => command.type === "turn.submit"),
      ).toBe(true);

      const payload = nextRealtimeMessage(submitter.socket, "device-handoff");
      const handoffResponse = await server.app.request(
        "/api/v1/device-handoff",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "only the actual submitter gets this",
            origin: {
              threadId: thread.id,
              turnId: "turn-bound-submission",
            },
          }),
        },
      );
      expect(handoffResponse.status).toBe(200);
      expect(await handoffResponse.json()).toEqual({ delivered: 1 });
      await expect(payload).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "only the actual submitter gets this" },
      });
      await expectNoRealtimeMessage(forged.socket, "device-handoff");
    } finally {
      submitter.socket.close();
      forged.socket.close();
      rpc.unregister();
      await server.close();
    }
  });

  it("binds the first cold-start phone turn to its newly issued device token", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-cold-device-identity",
      threadId: thread.id,
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-cold-device-identity",
      threadId: thread.id,
      turnId: "turn-cold-device-identity",
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const olderDevice = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const coldStartPhone = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const olderDeviceHandoffs: Record<string, unknown>[] = [];
    olderDevice.socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "device-handoff") olderDeviceHandoffs.push(frame);
    });
    try {
      for (const socket of [olderDevice.socket, coldStartPhone.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }
      const submitTurn = (token: string, text: string) =>
        server.app.request(`/api/v1/threads/${thread.id}/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: token,
          },
          body: JSON.stringify({
            input: [{ type: "text", text }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        });

      const oldTurnResponse = await submitTurn(
        olderDevice.token,
        "Earlier device submitted first",
      );
      expect(oldTurnResponse.status).toBe(200);
      await expect(oldTurnResponse.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      const phoneHandoff = nextRealtimeMessage(
        coldStartPhone.socket,
        "device-handoff",
      );
      const phoneTurnResponse = await submitTurn(
        coldStartPhone.token,
        "Cold-start phone submitted now",
      );
      expect(phoneTurnResponse.status).toBe(200);
      await expect(phoneTurnResponse.json()).resolves.toMatchObject({
        delivery: "sent",
      });

      const handoffResponse = await server.app.request(
        "/api/v1/device-handoff",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "first cold-start phone handoff",
            origin: { threadId: thread.id },
          }),
        },
      );
      expect(handoffResponse.status).toBe(200);
      expect(await handoffResponse.json()).toEqual({ delivered: 1 });
      await expect(phoneHandoff).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "first cold-start phone handoff" },
      });
      await expectNoRealtimeMessage(olderDevice.socket, "device-handoff");
      expect(olderDeviceHandoffs).toHaveLength(0);
      expect(
        rpc.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(2);
    } finally {
      olderDevice.socket.close();
      coldStartPhone.socket.close();
      rpc.unregister();
      await server.close();
    }
  });

  it("routes the first cold-start phone turn by its generated identity before its socket connects", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-unknown-device-identity",
      threadId: thread.id,
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-unknown-device-identity",
      threadId: thread.id,
      turnId: "turn-unknown-device-identity",
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const olderDevice = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const storedIdentity = new Map<string, string>();
    const phoneDeviceIdentity = createDeviceHandoffIdentityManager({
      readStoredId: () =>
        storedIdentity.get(DEVICE_HANDOFF_DEVICE_STORAGE_KEY) ?? null,
      storeId: (value) =>
        storedIdentity.set(DEVICE_HANDOFF_DEVICE_STORAGE_KEY, value),
      createId: () => {
        const bytes = new Uint8Array(16);
        bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
        return Buffer.from(bytes).toString("base64url");
      },
    });
    const generatedPhoneDeviceId = phoneDeviceIdentity.ensure();
    expect(generatedPhoneDeviceId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect([...storedIdentity.values()]).toEqual([generatedPhoneDeviceId]);
    const olderFrames: Record<string, unknown>[] = [];
    olderDevice.socket.on("message", (data) => {
      olderFrames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    let coldStartPhone: Awaited<
      ReturnType<typeof connectRealtimeWithToken>
    > | null = null;
    try {
      sendRealtime(olderDevice.socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(olderDevice.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(olderDevice.socket, "pong");
      sendRealtime(olderDevice.socket, { type: "ping" });
      await ready;
      const submitterSpy = vi.spyOn(
        server.deps.hub,
        "recordDeviceHandoffTurnSubmitter",
      );
      const coldPhoneTurn = await server.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: generatedPhoneDeviceId!,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Cold-start phone submits now" }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(coldPhoneTurn.status).toBe(200);
      await expect(coldPhoneTurn.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      const phoneBinding = submitterSpy.mock.calls.find(
        ([token]) => token === generatedPhoneDeviceId,
      );
      expect(phoneBinding).toBeDefined();
      expect(phoneBinding?.[1]).toBe(thread.id);
      expect(phoneBinding?.[3]).toBe("turn-unknown-device-identity");
      const phoneTurnId = phoneBinding?.[3];
      expect(phoneTurnId).toBeDefined();
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        phoneTurnId,
      );

      coldStartPhone = await connectRealtimeWithToken(server.baseUrl, {
        origin,
        deviceId: generatedPhoneDeviceId!,
      });
      const phoneHandoff = nextRealtimeMessage(
        coldStartPhone.socket,
        "device-handoff",
      );
      sendRealtime(coldStartPhone.socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(coldStartPhone.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const phoneReady = nextRealtimeMessage(coldStartPhone.socket, "pong");
      sendRealtime(coldStartPhone.socket, { type: "ping" });
      await phoneReady;

      server.deps.hub.recordDeviceHandoffTurnSubmitter(
        olderDevice.token,
        thread.id,
        "request-later-older-device",
        "turn-later-older-device",
      );
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        phoneTurnId,
      );
      submitterSpy.mockRestore();

      const handoff = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "must not go to the older device",
          origin: {
            threadId: thread.id,
            turnId: phoneTurnId!,
          },
        }),
      });
      expect(handoff.status, await handoff.clone().text()).toBe(200);
      await expect(handoff.json()).resolves.toEqual({ delivered: 1 });
      await expect(phoneHandoff).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "must not go to the older device" },
      });
      await expectNoRealtimeMessage(olderDevice.socket, "device-handoff");
      expect(
        olderFrames.filter((frame) => frame.type === "device-handoff"),
      ).toHaveLength(0);
      expect(
        rpc.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(1);

      const shimDirectory = await mkdtemp(
        join(tmpdir(), "bb-device-handoff-cli-shim-"),
      );
      try {
        const cliBin = resolve(process.cwd(), "../cli/bin");
        for (const file of ["bb-device-handoff-shim", "open"]) {
          await copyFile(join(cliBin, file), join(shimDirectory, file));
          await chmod(join(shimDirectory, file), 0o755);
        }
        const cliRoot = resolve(process.cwd(), "../cli");
        await writeFile(
          join(shimDirectory, "bb"),
          `#!/bin/sh\ncd ${JSON.stringify(cliRoot)} || exit 1\nexec ${JSON.stringify(process.execPath)} --conditions=source --import tsx src/index.ts "$@"\n`,
          { mode: 0o755 },
        );
        await chmod(join(shimDirectory, "bb"), 0o755);
        const cliUrl = "https://example.com/cold-start-device-handoff";
        const phoneCliHandoff = nextRealtimeMessage(
          coldStartPhone.socket,
          "device-handoff",
          30_000,
        );
        const notifyDeviceHandoff = vi.spyOn(
          server.deps.hub,
          "notifyDeviceHandoff",
        );
        const cliResponses: Array<{ status: number; body: unknown }> = [];
        const cliApiProxy = http.createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const upstream = await fetch(
              new URL(request.url ?? "/", server.baseUrl),
              {
                method: request.method,
                headers:
                  typeof request.headers["content-type"] === "string"
                    ? { "content-type": request.headers["content-type"] }
                    : undefined,
                body:
                  request.method === "GET" || request.method === "HEAD"
                    ? undefined
                    : Buffer.concat(chunks),
              },
            );
            const body = await upstream.text();
            if (request.url === "/api/v1/device-handoff") {
              cliResponses.push({
                status: upstream.status,
                body: JSON.parse(body) as unknown,
              });
            }
            response.statusCode = upstream.status;
            response.setHeader(
              "content-type",
              upstream.headers.get("content-type") ?? "application/json",
            );
            response.end(body);
          })().catch((error: unknown) => {
            response.statusCode = 502;
            response.end(
              error instanceof Error ? error.message : String(error),
            );
          });
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          cliApiProxy.once("error", rejectListen);
          cliApiProxy.listen(0, "127.0.0.1", resolveListen);
        });
        const cliProxyAddress = cliApiProxy.address();
        if (cliProxyAddress === null || typeof cliProxyAddress === "string") {
          throw new Error("CLI API proxy did not bind to a TCP port");
        }
        const cliEnv: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
          BB_CLI_REEXEC: "1",
          BB_DATA_DIR: join(shimDirectory, "data"),
          BB_SERVER_URL: `http://127.0.0.1:${cliProxyAddress.port}`,
          BB_THREAD_ID: thread.id,
          BB_TURN_ID: phoneTurnId!,
        };
        delete cliEnv.DISPLAY;
        delete cliEnv.WAYLAND_DISPLAY;
        const cliResult = await new Promise<{
          code: number;
          errorMessage: string | null;
          stderr: string;
          stdout: string;
        }>((resolveResult) => {
          execFile(
            join(shimDirectory, "open"),
            [cliUrl],
            {
              cwd: shimDirectory,
              env: cliEnv,
            },
            (error, stdout, stderr) => {
              resolveResult({
                code:
                  error === null
                    ? 0
                    : typeof error.code === "number"
                      ? error.code
                      : 1,
                errorMessage: error?.message ?? null,
                stderr,
                stdout,
              });
            },
          );
        });
        await new Promise<void>((resolveClose, rejectClose) => {
          cliApiProxy.close((error) =>
            error ? rejectClose(error) : resolveClose(),
          );
        });
        expect(cliResult, JSON.stringify(cliResult)).toMatchObject({
          code: 0,
          stderr: "",
        });
        expect(cliResponses).toEqual([{ status: 200, body: { delivered: 1 } }]);
        expect(
          notifyDeviceHandoff.mock.calls.map((call, index) => ({
            request: call[0],
            origin: call[0].origin,
            turnRequestId: call[3],
            delivered: notifyDeviceHandoff.mock.results[index]?.value,
          })),
        ).toEqual([
          expect.objectContaining({
            request: {
              kind: "open-url",
              url: cliUrl,
              origin: {
                threadId: thread.id,
                turnId: phoneTurnId,
              },
            },
            origin: {
              threadId: thread.id,
              turnId: phoneTurnId,
            },
            delivered: 1,
          }),
        ]);
        await expect(phoneCliHandoff).resolves.toMatchObject({
          type: "device-handoff",
          request: { url: cliUrl },
        });
        await expectNoRealtimeMessage(olderDevice.socket, "device-handoff");
      } finally {
        await rm(shimDirectory, { recursive: true, force: true });
      }
    } finally {
      olderDevice.socket.close();
      coldStartPhone?.socket.close();
      rpc.unregister();
      await server.close();
    }
  }, 30_000);

  it("routes active-turn handoffs to the device that most recently sent through /send", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "idle" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-steer-rebinding",
      threadId: thread.id,
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const phone = await connectRealtimeWithToken(server.baseUrl, { origin });
    const desktop = await connectRealtimeWithToken(server.baseUrl, { origin });
    const subscribe = async (socket: WebSocket) => {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await ready;
    };
    try {
      await subscribe(phone.socket);
      await subscribe(desktop.socket);
      const turnSubmitRequestId = (index: number): string => {
        const commands = rpc.requests.flatMap(({ command }) =>
          command.type === "turn.submit" ? [command] : [],
        );
        const requestId = commands[index]?.requestId;
        expect(requestId).toBeTruthy();
        return requestId!;
      };
      const phoneStart = await postThreadSend(server, {
        threadId: thread.id,
        token: phone.token,
        text: "Phone starts the turn",
        mode: "auto",
      });
      expect(phoneStart.status, await phoneStart.clone().text()).toBe(200);
      await expect(phoneStart.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      const phoneTurnId = "turn-phone-started-device-binding";
      seedTurnStarted(server.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-steer-rebinding",
        threadId: thread.id,
        turnId: phoneTurnId!,
      });
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-steer-rebinding",
        sequence: 100,
        type: "turn/input/accepted",
        scope: turnScope(phoneTurnId!),
        data: { clientRequestId: turnSubmitRequestId(0) },
      });
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        phoneTurnId,
      );

      const sendHandoff = async (
        text: string,
        recipient: typeof phone | typeof desktop,
        nonRecipient: typeof phone | typeof desktop,
      ) => {
        const recipientFrame = nextRealtimeMessage(
          recipient.socket,
          "device-handoff",
        );
        const response = await server.app.request("/api/v1/device-handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text,
            origin: { threadId: thread.id, turnId: phoneTurnId },
          }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        await expect(response.json()).resolves.toEqual({ delivered: 1 });
        await expect(recipientFrame).resolves.toMatchObject({
          type: "device-handoff",
          request: { text },
        });
        await expectNoRealtimeMessage(nonRecipient.socket, "device-handoff");
      };

      await sendHandoff("phone started", phone, desktop);
      const desktopSteer = await postThreadSend(server, {
        threadId: thread.id,
        token: desktop.token,
        text: "Desktop steers the phone turn",
        mode: "steer",
      });
      expect(desktopSteer.status, await desktopSteer.clone().text()).toBe(200);
      await expect(desktopSteer.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        phoneTurnId,
      );
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-steer-rebinding",
        sequence: 200,
        type: "turn/input/accepted",
        scope: turnScope(phoneTurnId!),
        data: { clientRequestId: turnSubmitRequestId(1) },
      });
      await sendHandoff("desktop steered", desktop, phone);

      const phoneSteer = await postThreadSend(server, {
        threadId: thread.id,
        token: phone.token,
        text: "Phone steers the same turn again",
        mode: "steer",
      });
      expect(phoneSteer.status, await phoneSteer.clone().text()).toBe(200);
      await expect(phoneSteer.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        phoneTurnId,
      );
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-steer-rebinding",
        sequence: 300,
        type: "turn/input/accepted",
        scope: turnScope(phoneTurnId!),
        data: { clientRequestId: turnSubmitRequestId(2) },
      });
      await sendHandoff("phone steered again", phone, desktop);
      expect(
        rpc.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(3);
    } finally {
      phone.socket.close();
      desktop.socket.close();
      rpc.unregister();
      await server.close();
    }
  });

  it("routes a new turn to its sender and rejects the ended turn id", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "idle" },
    });
    const providerThreadId = "provider-thread-turn-replacement";
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId,
      threadId: thread.id,
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const phone = await connectRealtimeWithToken(server.baseUrl, { origin });
    const desktop = await connectRealtimeWithToken(server.baseUrl, { origin });
    const subscribe = async (socket: WebSocket) => {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await ready;
    };
    try {
      await subscribe(phone.socket);
      await subscribe(desktop.socket);
      const turnSubmitRequestId = (index: number): string => {
        const commands = rpc.requests.flatMap(({ command }) =>
          command.type === "turn.submit" ? [command] : [],
        );
        const requestId = commands[index]?.requestId;
        expect(requestId).toBeTruthy();
        return requestId!;
      };
      const phoneStart = await postThreadSend(server, {
        threadId: thread.id,
        token: phone.token,
        text: "Phone starts the first turn",
        mode: "auto",
      });
      expect(phoneStart.status, await phoneStart.clone().text()).toBe(200);
      await expect(phoneStart.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      const oldTurnId = "turn-phone-ended-device-binding";
      seedTurnStarted(server.deps, {
        environmentId: environment.id,
        providerThreadId,
        threadId: thread.id,
        turnId: oldTurnId!,
      });
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 100,
        type: "turn/input/accepted",
        scope: turnScope(oldTurnId!),
        data: { clientRequestId: turnSubmitRequestId(0) },
      });
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        oldTurnId,
      );
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 101,
        type: "turn/completed",
        scope: turnScope(oldTurnId!),
        data: { status: "completed" },
      });
      applyLoggedThreadLifecycleEvent(server.deps, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });
      expect(getThread(server.deps.db, thread.id)?.status).toBe("idle");
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBeNull();

      const desktopStart = await postThreadSend(server, {
        threadId: thread.id,
        token: desktop.token,
        text: "Desktop starts the next turn",
        mode: "auto",
      });
      expect(desktopStart.status, await desktopStart.clone().text()).toBe(200);
      await expect(desktopStart.json()).resolves.toMatchObject({
        delivery: "sent",
      });
      const currentTurnId = "turn-desktop-started-device-binding";
      seedTurnStarted(server.deps, {
        environmentId: environment.id,
        providerThreadId,
        threadId: thread.id,
        turnId: currentTurnId!,
      });
      seedEvent(server.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 200,
        type: "turn/input/accepted",
        scope: turnScope(currentTurnId!),
        data: { clientRequestId: turnSubmitRequestId(1) },
      });
      expect(getActiveTurnId({ db: server.deps.db }, thread.id)).toBe(
        currentTurnId,
      );
      expect(currentTurnId).not.toBe(oldTurnId);

      const staleTurnHandoff = await server.app.request(
        "/api/v1/device-handoff",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "old turn payload",
            origin: { threadId: thread.id, turnId: oldTurnId },
          }),
        },
      );
      expect(staleTurnHandoff.status).toBe(409);
      await expect(staleTurnHandoff.json()).resolves.toEqual({
        code: "device_handoff_turn_mismatch",
        message: "BB_TURN_ID does not match the thread's current turn",
      });

      const desktopHandoff = nextRealtimeMessage(
        desktop.socket,
        "device-handoff",
      );
      const currentTurnHandoff = await server.app.request(
        "/api/v1/device-handoff",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "copy-text",
            text: "desktop current turn",
            origin: { threadId: thread.id },
          }),
        },
      );
      expect(currentTurnHandoff.status).toBe(200);
      await expect(currentTurnHandoff.json()).resolves.toEqual({
        delivered: 1,
      });
      await expect(desktopHandoff).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "desktop current turn" },
      });
      await expectNoRealtimeMessage(phone.socket, "device-handoff");
      expect(
        rpc.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(2);
    } finally {
      phone.socket.close();
      desktop.socket.close();
      rpc.unregister();
      await server.close();
    }
  });

  it("returns a clear error when BB_TURN_ID is not the current turn", async () => {
    const server = await startTestServer();
    const { environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: "turn-device-handoff-current",
    });
    try {
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "wrong turn",
          origin: {
            threadId: thread.id,
            turnId: "turn-device-handoff-stale",
          },
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "device_handoff_turn_mismatch",
        message: "BB_TURN_ID does not match the thread's current turn",
      });
    } finally {
      await server.close();
    }
  });

  it("binds a turn to a previously issued identity even when no device socket is connected", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-offline-known-device",
      threadId: thread.id,
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-offline-known-device",
      threadId: thread.id,
      turnId: "turn-offline-known-device",
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const knownDevice = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const deviceId = knownDevice.token;
    const closed = new Promise<void>((resolve) =>
      knownDevice.socket.once("close", () => resolve()),
    );
    knownDevice.socket.close();
    await closed;
    try {
      const turn = await server.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: deviceId,
          },
          body: JSON.stringify({
            input: [
              { type: "text", text: "Known device submits while offline" },
            ],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(turn.status).toBe(200);
      const handoff = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "queued for the known device",
          origin: { threadId: thread.id, turnId: "turn-offline-known-device" },
        }),
      });
      expect(handoff.status).toBe(200);
      await expect(handoff.json()).resolves.toEqual({ delivered: 0 });

      const reconnected = await connectRealtimeWithToken(server.baseUrl, {
        origin,
        deviceId,
      });
      try {
        const received = nextRealtimeMessage(
          reconnected.socket,
          "device-handoff",
        );
        sendRealtime(reconnected.socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(reconnected.socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        await expect(received).resolves.toMatchObject({
          type: "device-handoff",
          request: { text: "queued for the known device" },
        });
      } finally {
        reconnected.socket.close();
      }
    } finally {
      rpc.unregister();
      await server.close();
    }
  });

  it("re-adopts stored device identities after reopening the server database", async () => {
    const initialServer = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(
      initialServer,
      { thread: { status: "active" } },
    );
    seedThreadRuntimeState(initialServer.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-device-identity-restart",
      threadId: thread.id,
    });
    seedTurnStarted(initialServer.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-device-identity-restart",
      threadId: thread.id,
      turnId: "turn-device-identity-before-restart",
    });
    const origin = `http://127.0.0.1:${new URL(initialServer.baseUrl).port}`;
    const olderDevice = await connectRealtimeWithToken(initialServer.baseUrl, {
      origin,
    });
    const phoneBeforeRestart = await connectRealtimeWithToken(
      initialServer.baseUrl,
      { origin },
    );
    const olderDeviceId = olderDevice.token;
    const phoneDeviceId = phoneBeforeRestart.token;
    const priorRpc = registerHostRpcResponder(initialServer, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const earlierTurn = await initialServer.app.request(
      `/api/v1/threads/${thread.id}/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: olderDeviceId,
        },
        body: JSON.stringify({
          input: [
            { type: "text", text: "Older device submitted before restart" },
          ],
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        }),
      },
    );
    expect(earlierTurn.status).toBe(200);
    await expect(earlierTurn.json()).resolves.toMatchObject({
      delivery: "sent",
    });
    const serializedDb = initialServer.db.$client.serialize();
    olderDevice.socket.close();
    phoneBeforeRestart.socket.close();
    priorRpc.unregister();
    await initialServer.close();
    initialServer.db.$client.close();

    const reopenedDb = createConnection(serializedDb);
    const server = await startTestServer({ db: reopenedDb });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const restartedOrigin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    let olderDeviceAfterRestart: Awaited<
      ReturnType<typeof connectRealtimeWithToken>
    > | null = null;
    let phoneAfterRestart: Awaited<
      ReturnType<typeof connectRealtimeWithToken>
    > | null = null;
    try {
      const phoneTurn = await server.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: phoneDeviceId,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Phone turn after restart" }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(phoneTurn.status).toBe(200);
      await expect(phoneTurn.json()).resolves.toMatchObject({
        delivery: "sent",
      });

      olderDeviceAfterRestart = await connectRealtimeWithToken(server.baseUrl, {
        origin: restartedOrigin,
        deviceId: olderDeviceId,
      });
      phoneAfterRestart = await connectRealtimeWithToken(server.baseUrl, {
        origin: restartedOrigin,
        deviceId: phoneDeviceId,
      });
      expect(olderDeviceAfterRestart.token).toBe(olderDeviceId);
      expect(phoneAfterRestart.token).toBe(phoneDeviceId);
      for (const socket of [
        olderDeviceAfterRestart.socket,
        phoneAfterRestart.socket,
      ]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }

      const phoneHandoff = nextRealtimeMessage(
        phoneAfterRestart.socket,
        "device-handoff",
      );
      const handoff = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "same phone identity survived restart",
          origin: { threadId: thread.id },
        }),
      });
      expect(handoff.status).toBe(200);
      await expect(handoff.json()).resolves.toEqual({ delivered: 1 });
      await expect(phoneHandoff).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "same phone identity survived restart" },
      });
      await expectNoRealtimeMessage(
        olderDeviceAfterRestart.socket,
        "device-handoff",
      );
      expect(
        rpc.requests.filter(({ command }) => command.type === "turn.submit"),
      ).toHaveLength(1);
    } finally {
      olderDeviceAfterRestart?.socket.close();
      phoneAfterRestart?.socket.close();
      rpc.unregister();
      await server.close();
      reopenedDb.$client.close();
    }
  });

  it("ignores malformed device ids on socket connect and turn submission", async () => {
    const server = await startTestServer();
    const { host, session, environment, thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedThreadRuntimeState(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-malformed-device-identity",
      threadId: thread.id,
    });
    seedTurnStarted(server.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-thread-malformed-device-identity",
      threadId: thread.id,
      turnId: "turn-malformed-device-identity",
    });
    const rpc = registerHostRpcResponder(server, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type === "host.read_workspace_agent_context") {
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        }
        if (command.type === "turn.submit") {
          return { ok: true, result: { trace: { spans: [] } } };
        }
        return {
          ok: false,
          errorCode: "unsupported_test_command",
          errorMessage: `Unhandled test RPC ${command.type}`,
        };
      },
    });
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const malformed = "AAAAAAAAAAAAAAAAAAAAAB";
    const client = await connectRealtimeWithToken(server.baseUrl, {
      origin,
      deviceId: malformed,
    });
    try {
      expect(client.token).not.toBe(malformed);
      expect(client.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const turn = await server.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DEVICE_HANDOFF_CLIENT_TOKEN_HEADER]: malformed,
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Malformed identity is ignored" }],
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );
      expect(turn.status).toBe(200);
      const handoff = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "must fail closed for malformed identity",
          origin: { threadId: thread.id },
        }),
      });
      expect(handoff.status).toBe(409);
      await expect(handoff.json()).resolves.toMatchObject({
        code: "device_handoff_no_recipient",
      });
    } finally {
      client.socket.close();
      rpc.unregister();
      await server.close();
    }
  });

  it("binds a thread-only payload to the socket that submitted the turn", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const submitter = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    const sockets = [submitter.socket, forged.socket];
    try {
      for (const socket of sockets) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const submitterReady = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await submitterReady;
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          submitter.token,
          thread.id,
          "turn-request-direct",
          "turn-direct",
        ),
      ).toBe(true);
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          "foreign-socket-token",
          thread.id,
          "turn-request-foreign",
          "turn-foreign",
        ),
      ).toBe(false);
      const submittedPayload = nextRealtimeMessage(
        submitter.socket,
        "device-handoff",
      );
      const delivered = server.hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "bound to submitted turn",
          origin: { threadId: thread.id, turnId: "turn-direct" },
        },
        thread.title ?? "Thread",
        thread.id,
        "turn-request-unmatched",
      );
      expect(delivered).toBe(1);
      await expect(submittedPayload).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "bound to submitted turn" },
      });
      await expectNoRealtimeMessage(forged.socket, "device-handoff");
      const directSignal = await submittedPayload;
      sendRealtime(submitter.socket, {
        type: "device-handoff-ack",
        id: directSignal.id as string,
      });
      const directAcknowledged = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await directAcknowledged;

      sendRealtime(submitter.socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      });
      const noViewReady = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await noViewReady;
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          submitter.token,
          thread.id,
          "turn-request-pending",
          "turn-pending",
        ),
      ).toBe(true);
      expect(
        server.hub.notifyDeviceHandoff(
          {
            kind: "open-url",
            url: "https://example.com/pending",
            origin: { threadId: thread.id, turnId: "turn-pending" },
          },
          thread.title ?? "Thread",
          thread.id,
          "turn-request-unmatched",
        ),
      ).toBe(0);
      const pendingPayload = nextRealtimeMessage(
        submitter.socket,
        "device-handoff",
      );
      sendRealtime(submitter.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const viewReady = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await viewReady;
      await expect(pendingPayload).resolves.toMatchObject({
        type: "device-handoff",
        request: { url: "https://example.com/pending" },
      });
      await expectNoRealtimeMessage(forged.socket, "device-handoff");
    } finally {
      submitter.socket.close();
      forged.socket.close();
      await server.close();
    }
  });

  it("fails closed for a thread-only handoff when no device has submitted a turn", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    try {
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          "unknown-device-token",
          thread.id,
          "disconnected-turn-request",
        ),
      ).toBe(false);
      sendRealtime(forged.socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(forged.socket, "pong");
      sendRealtime(forged.socket, { type: "ping" });
      await ready;
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          "foreign-device-token",
          thread.id,
          "foreign-turn-request",
        ),
      ).toBe(false);
      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "open-url",
          url: "https://example.com/private-code",
          origin: { threadId: thread.id },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain(
        "No device has sent a message in this thread yet",
      );
      await expectNoRealtimeMessage(forged.socket, "device-handoff");
      await expectNoRealtimeMessage(forged.socket, "device-handoff-expired");
    } finally {
      forged.socket.close();
      await server.close();
    }
  });

  it("delivers SDK handoffs to the latest submitter and surfaces no-submitter errors", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const noSubmitterSdk = createNodeBbSdk({ baseUrl: server.baseUrl });
    await expect(
      noSubmitterSdk.device.request({
        kind: "open-url",
        url: "https://example.com/no-submitter",
        origin: { threadId: thread.id },
      }),
    ).rejects.toMatchObject({
      code: "device_handoff_no_recipient",
      status: 409,
    });

    const { socket, token } = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    try {
      sendRealtime(socket, {
        type: "subscribe",
        target: { kind: "thread-detail", threadId: thread.id },
      });
      sendRealtime(socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const ready = nextRealtimeMessage(socket, "pong");
      sendRealtime(socket, { type: "ping" });
      await ready;
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          token,
          thread.id,
          "sdk-device-turn-request",
        ),
      ).toBe(true);
      const sdk = createNodeBbSdk({
        baseUrl: server.baseUrl,
        fetch: (input, init) => {
          const headers = new Headers(
            input instanceof Request ? input.headers : undefined,
          );
          new Headers(init?.headers).forEach((value, key) =>
            headers.set(key, value),
          );
          headers.set(DEVICE_HANDOFF_CLIENT_TOKEN_HEADER, token);
          return fetch(input, { ...init, headers });
        },
      });
      const received = nextRealtimeMessage(socket, "device-handoff");
      await expect(
        sdk.device.request({
          kind: "copy-text",
          text: "SDK handoff to the latest submitter",
          origin: { threadId: thread.id },
        }),
      ).resolves.toEqual({ delivered: 1 });
      await expect(received).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "SDK handoff to the latest submitter" },
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("delivers a pending shell handoff only to the submitting device after reconnect", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const submitter = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    const forgedFrames: Record<string, unknown>[] = [];
    forged.socket.on("message", (data) =>
      forgedFrames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    try {
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          submitter.token,
          thread.id,
          "shell-origin-request",
          "shell-origin-turn",
        ),
      ).toBe(true);
      for (const socket of [submitter.socket, forged.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
      }
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const forgedReady = nextRealtimeMessage(forged.socket, "pong");
      sendRealtime(forged.socket, { type: "ping" });
      await forgedReady;
      const closed = new Promise<void>((resolve) =>
        submitter.socket.once("close", () => resolve()),
      );
      submitter.socket.close();
      await closed;

      const response = await server.app.request("/api/v1/device-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "copy-text",
          text: "queued for the submitting device",
          origin: { threadId: thread.id },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 0 });
      await expectNoRealtimeMessage(forged.socket, "device-handoff");

      const reconnected = await connectRealtimeWithToken(server.baseUrl, {
        origin,
        deviceId: submitter.token,
      });
      try {
        const received = nextRealtimeMessage(
          reconnected.socket,
          "device-handoff",
        );
        sendRealtime(reconnected.socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(reconnected.socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        await expect(received).resolves.toMatchObject({
          type: "device-handoff",
          request: { text: "queued for the submitting device" },
        });
        expect(
          forgedFrames.filter((frame) => frame.type === "device-handoff"),
        ).toHaveLength(0);
      } finally {
        reconnected.socket.close();
      }
    } finally {
      submitter.socket.close();
      forged.socket.close();
      await server.close();
    }
  });

  it("routes an expired submitted-turn notice only to the submitting socket", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const submitter = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const forged = await connectRealtimeWithToken(server.baseUrl, { origin });
    const submitterFrames: Record<string, unknown>[] = [];
    const forgedFrames: Record<string, unknown>[] = [];
    submitter.socket.on("message", (data) =>
      submitterFrames.push(
        JSON.parse(data.toString()) as Record<string, unknown>,
      ),
    );
    forged.socket.on("message", (data) =>
      forgedFrames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    try {
      for (const socket of [submitter.socket, forged.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          submitter.token,
          thread.id,
          "turn-request-expiry-binding",
          "turn-expiry-binding",
        ),
      ).toBe(true);
      const payload = nextRealtimeMessage(submitter.socket, "device-handoff");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      expect(
        server.hub.notifyDeviceHandoff(
          {
            kind: "copy-text",
            text: "secret that expires",
            origin: {
              threadId: thread.id,
              turnId: "turn-expiry-binding",
            },
          },
          thread.title ?? "Thread",
          thread.id,
          "turn-request-unmatched",
        ),
      ).toBe(1);
      const direct = await payload;
      expect(direct.request).toMatchObject({ text: "secret that expires" });
      sendRealtime(submitter.socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      });
      const submitterAway = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await submitterAway;
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: null,
        terminalSessionId: null,
      });
      const forgedAway = nextRealtimeMessage(forged.socket, "pong");
      sendRealtime(forged.socket, { type: "ping" });
      await forgedAway;

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      const forgedReturned = nextRealtimeMessage(forged.socket, "pong");
      sendRealtime(forged.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      sendRealtime(forged.socket, { type: "ping" });
      await forgedReturned;
      const submitterReturned = nextRealtimeMessage(
        submitter.socket,
        "device-handoff-expired",
      );
      sendRealtime(submitter.socket, {
        type: "device-handoff-view",
        threadId: thread.id,
        terminalSessionId: null,
      });
      const submitterPong = nextRealtimeMessage(submitter.socket, "pong");
      sendRealtime(submitter.socket, { type: "ping" });
      await Promise.all([submitterPong, submitterReturned]);
      const expiredFrames = submitterFrames.filter(
        (frame) => frame.type === "device-handoff-expired",
      );
      expect(expiredFrames).toHaveLength(1);
      expect(
        forgedFrames.some((frame) => frame.type === "device-handoff-expired"),
      ).toBe(false);
      expect(JSON.stringify(expiredFrames)).not.toContain(
        "secret that expires",
      );
    } finally {
      vi.useRealTimers();
      submitter.socket.close();
      forged.socket.close();
      await server.close();
    }
  });

  it("delivers expiry only to the submitting device after it reconnects", async () => {
    const server = await startTestServer();
    const { thread } = seedThreadFixture(server);
    const origin = `http://127.0.0.1:${new URL(server.baseUrl).port}`;
    const submitter = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const otherViewer = await connectRealtimeWithToken(server.baseUrl, {
      origin,
    });
    const forgedExpiryFrames: Record<string, unknown>[] = [];
    otherViewer.socket.on("message", (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === "device-handoff-expired")
        forgedExpiryFrames.push(frame);
    });
    try {
      for (const socket of [submitter.socket, otherViewer.socket]) {
        sendRealtime(socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const ready = nextRealtimeMessage(socket, "pong");
        sendRealtime(socket, { type: "ping" });
        await ready;
      }
      expect(
        server.hub.recordDeviceHandoffTurnSubmitter(
          submitter.token,
          thread.id,
          "turn-request-reconnect-expiry",
          "turn-reconnect-expiry",
        ),
      ).toBe(true);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(Date.now());
      const payload = nextRealtimeMessage(submitter.socket, "device-handoff");
      expect(
        server.hub.notifyDeviceHandoff(
          {
            kind: "copy-text",
            text: "private payload for the phone",
            origin: { threadId: thread.id, turnId: "turn-reconnect-expiry" },
          },
          thread.title ?? "Thread",
          thread.id,
          "turn-request-reconnect-expiry",
        ),
      ).toBe(1);
      await expect(payload).resolves.toMatchObject({
        type: "device-handoff",
        request: { text: "private payload for the phone" },
      });
      const submitterClosed = new Promise<void>((resolve) => {
        submitter.socket.once("close", () => resolve());
      });
      submitter.socket.close();
      await submitterClosed;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(forgedExpiryFrames).toHaveLength(0);
      const reconnected = await connectRealtimeWithToken(server.baseUrl, {
        origin,
        deviceId: submitter.token,
      });
      try {
        const expired = nextRealtimeMessage(
          reconnected.socket,
          "device-handoff-expired",
        );
        sendRealtime(reconnected.socket, {
          type: "subscribe",
          target: { kind: "thread-detail", threadId: thread.id },
        });
        sendRealtime(reconnected.socket, {
          type: "device-handoff-view",
          threadId: thread.id,
          terminalSessionId: null,
        });
        const notice = await expired;
        expect(notice).toMatchObject({
          type: "device-handoff-expired",
          threadId: thread.id,
          terminalSessionId: null,
        });
        expect(JSON.stringify(notice)).not.toContain(
          "private payload for the phone",
        );
        expect(forgedExpiryFrames).toHaveLength(0);
      } finally {
        reconnected.socket.close();
      }
    } finally {
      vi.useRealTimers();
      submitter.socket.close();
      otherViewer.socket.close();
      await server.close();
    }
  });
});
