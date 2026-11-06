import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertHost } from "@bb/db";
import type { HostDaemonLogger } from "../../../host-daemon/src/logger.js";
import { createProtocolSelfUpdater } from "../../../host-daemon/src/protocol-self-update.js";
import {
  createServerClient,
  type FetchFn,
} from "../../../host-daemon/src/server-client.js";
import { ServerConnection } from "../../../host-daemon/src/server-connection.js";
import type {
  CreateReconnectingWebSocket,
  ReconnectingWebSocketLike,
} from "../../../host-daemon/src/server-connection-support.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

const dataDirs: string[] = [];

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies HostDaemonLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createReconnectSocket(): CreateReconnectingWebSocket {
  return (urlProvider) => {
    let readyState = 0;
    let closed = false;
    let attempts = 0;
    const socket: ReconnectingWebSocketLike = {
      get bufferedAmount() {
        return 0;
      },
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(() => {
        closed = true;
        readyState = 3;
      }),
      reconnect: vi.fn(() => {
        readyState = 0;
        void connect();
      }),
    };

    async function connect(): Promise<void> {
      if (closed) return;
      attempts += 1;
      try {
        await urlProvider();
        readyState = 1;
        socket.onopen?.({ type: "open" });
      } catch (error) {
        socket.onerror?.(error);
        if (!closed && attempts < 3) queueMicrotask(() => void connect());
      }
    }

    queueMicrotask(() => void connect());
    return socket;
  };
}

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("integrated daemon protocol update", () => {
  it("updates a 260 daemon from the mismatch response, then reconnects and opens a 261 session", async () => {
    const server = await startTestServer();
    const hostId = "host-protocol-update-integration";
    const hostKey = createTestDaemonHostKey({ hostId });
    upsertHost(server.db, server.hub, { id: hostId, name: "Protocol Host" });
    server.hub.requestHostProtocolUpdateRetry(hostId);

    const dataDir = await mkdtemp(join(tmpdir(), "bb-protocol-update-integration-"));
    dataDirs.push(dataDir);
    const logger = createLogger();
    const installed: string[] = [];
    const tarball = Buffer.from("test-host-package");
    const digest = createHash("sha256").update(tarball).digest("hex");
    const updater = createProtocolSelfUpdater({
      currentProtocolVersion: 260,
      dataDir,
      enabled: true,
      fetchFn: async (input) => {
        if (String(input).endsWith("/install/version")) {
          return Response.json({ version: "9.0.0-test", protocolVersion: 261 });
        }
        return new Response(tarball, {
          headers: {
            "content-length": String(tarball.byteLength),
            "content-type": "application/gzip",
            "x-bb-artifact-sha256": digest,
          },
        });
      },
      installTarball: async (tarballPath) => {
        installed.push(tarballPath);
      },
      logger,
      serverHeaders: {},
      serverUrl: server.baseUrl,
    });

    let sawStaleAttempt = false;
    let sessionId = "";
    let mismatchResponse: Record<string, unknown> | null = null;
    const openedProtocols: number[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const inputUrl = input instanceof URL ? input.href : String(input);
      if (!inputUrl.endsWith("/internal/session/open")) return fetch(input, init);
      const parsed: unknown = JSON.parse(String(init?.body));
      if (!isRecord(parsed)) throw new Error("session request body was not an object");
      const protocolVersion = sawStaleAttempt ? 261 : 260;
      sawStaleAttempt = true;
      openedProtocols.push(protocolVersion);
      const response = await fetch(input, {
        ...init,
        body: JSON.stringify({ ...parsed, protocolVersion }),
      });
      if (protocolVersion === 260) {
        const body: unknown = await response.clone().json();
        if (isRecord(body)) mismatchResponse = body;
      }
      return response;
    };
    const serverClient = createServerClient({
      getSessionId: () => sessionId,
      hostKey,
      logger,
      serverUrl: server.baseUrl,
      fetchFn,
    });
    let installedCallbackCount = 0;
    const connection = new ServerConnection({
      createWebSocket: createReconnectSocket(),
      dataDir,
      hostId,
      hostKey,
      hostName: "Protocol Host",
      instanceId: "protocol-update-instance",
      localApiPort: 38_888,
      logger,
      onSelfUpdateInstalled: () => {
        installedCallbackCount += 1;
      },
      protocolSelfUpdater: updater,
      serverClient,
      serverUrl: server.baseUrl,
      setSession: (session) => {
        sessionId = session?.sessionId ?? "";
      },
      startupTimeoutMs: 5_000,
    });

    try {
      const session = await connection.start();
      expect(mismatchResponse).toMatchObject({
        code: "protocol_version_mismatch",
        details: { retryUpdate: true, serverProtocolVersion: 261 },
      });
      expect(openedProtocols).toEqual([260, HOST_DAEMON_PROTOCOL_VERSION]);
      expect(installed).toHaveLength(1);
      expect(installedCallbackCount).toBe(1);
      expect(session.sessionId).toBeTruthy();
      expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(261);
    } finally {
      await connection.shutdown();
      await server.close();
    }
  });
});
