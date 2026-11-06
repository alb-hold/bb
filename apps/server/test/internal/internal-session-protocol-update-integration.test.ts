import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertHost } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

const dataDirs: string[] = [];

interface TestServerClient {
  openSession(args: Record<string, unknown>): Promise<{ sessionId: string }>;
}

interface TestProtocolSelfUpdater {
  handleProtocolMismatch(options?: { force?: boolean }): Promise<string>;
}

interface TestConnection {
  start(): Promise<{ sessionId: string }>;
  shutdown(): Promise<void>;
}

type TestFetchFn = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

interface TestSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  reconnect(code?: number, reason?: string): void;
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createReconnectSocket() {
  return (urlProvider: () => Promise<string>): TestSocket => {
    let readyState = 0;
    let closed = false;
    let attempts = 0;
    const socket: TestSocket = {
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
  await Promise.all(
    dataDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("integrated daemon protocol update", () => {
  it.each([260, 261])(
    "reconnects with the installed protocol version %s from the unmodified request builder",
    async (installedProtocolVersion) => {
      const clientModule = await vi.importActual<{
        createServerClient(options: Record<string, unknown>): TestServerClient;
      }>("../../../host-daemon/src/server-client.js");
      const updaterModule = await vi.importActual<{
        createProtocolSelfUpdater(
          options: Record<string, unknown>,
        ): TestProtocolSelfUpdater;
      }>("../../../host-daemon/src/protocol-self-update.js");
      const connectionModule = await vi.importActual<{
        ServerConnection: new (
          options: Record<string, unknown>,
        ) => TestConnection;
      }>("../../../host-daemon/src/server-connection.js");
      const server = await startTestServer();
      const hostId = "host-protocol-update-integration";
      const hostKey = createTestDaemonHostKey({ hostId });
      upsertHost(server.db, server.hub, { id: hostId, name: "Protocol Host" });
      server.hub.requestHostProtocolUpdateRetry(hostId);

      const dataDir = await mkdtemp(
        join(tmpdir(), "bb-protocol-update-integration-"),
      );
      dataDirs.push(dataDir);
      const installedProtocolPath = join(dataDir, "installed-protocol-version");
      await writeFile(installedProtocolPath, "260");
      const logger = createLogger();
      const installed: string[] = [];
      const tarball = Buffer.from("test-host-package");
      const digest = createHash("sha256").update(tarball).digest("hex");
      const updater = updaterModule.createProtocolSelfUpdater({
        currentProtocolVersion: 260,
        dataDir,
        enabled: true,
        fetchFn: async (input: RequestInfo | URL) => {
          if (String(input).endsWith("/install/version")) {
            return Response.json({
              version: "9.0.0-test",
              protocolVersion: 261,
            });
          }
          return new Response(tarball, {
            headers: {
              "content-length": String(tarball.byteLength),
              "content-type": "application/gzip",
              "x-bb-artifact-sha256": digest,
            },
          });
        },
        installTarball: async (tarballPath: string) => {
          installed.push(tarballPath);
          await writeFile(
            installedProtocolPath,
            String(installedProtocolVersion),
          );
        },
        logger,
        serverHeaders: {},
        serverUrl: server.baseUrl,
      });

      let sessionId = "";
      let mismatchResponse: Record<string, unknown> | null = null;
      const openedProtocols: number[] = [];
      const fetchFn: TestFetchFn = async (input, init) => {
        const inputUrl = input instanceof URL ? input.href : String(input);
        if (!inputUrl.endsWith("/internal/session/open"))
          return fetch(input, init);
        const parsed: unknown = JSON.parse(String(init?.body));
        if (!isRecord(parsed))
          throw new Error("session request body was not an object");
        const protocolVersion = Number(parsed.protocolVersion);
        openedProtocols.push(protocolVersion);
        const response = await fetch(input, init);
        if (protocolVersion === 260 && mismatchResponse === null) {
          const body: unknown = await response.clone().json();
          if (isRecord(body)) mismatchResponse = body;
        }
        return response;
      };
      const serverClient = clientModule.createServerClient({
        getSessionId: () => sessionId,
        hostKey,
        logger,
        serverUrl: server.baseUrl,
        fetchFn,
        getProtocolVersion: async () =>
          Number(await readFile(installedProtocolPath, "utf8")),
      });
      let installedCallbackCount = 0;
      const connection = new connectionModule.ServerConnection({
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
        setSession: (session: { sessionId: string } | null) => {
          sessionId = session?.sessionId ?? "";
        },
        startupTimeoutMs: 5_000,
      });

      try {
        const sessionArgs = {
          activeThreads: [],
          adoptedThreads: [],
          dataDir,
          hostId,
          hostName: "Protocol Host",
          instanceId: "protocol-update-instance",
          loadedEnvironments: [],
          localApiPort: 38_888,
          undeliveredEventThreadIds: [],
        };
        if (installedProtocolVersion === 260) {
          await expect(
            serverClient.openSession(sessionArgs),
          ).rejects.toMatchObject({
            code: "protocol_version_mismatch",
          });
          await expect(
            updater.handleProtocolMismatch({ force: true }),
          ).resolves.toBe("updated");
          await expect(readFile(installedProtocolPath, "utf8")).resolves.toBe(
            "260",
          );
          await expect(
            serverClient.openSession(sessionArgs),
          ).rejects.toMatchObject({
            code: "protocol_version_mismatch",
          });
        }
        let session: { sessionId: string } | undefined;
        let startError: unknown;
        if (installedProtocolVersion === 261) {
          try {
            session = await connection.start();
          } catch (error) {
            startError = error;
          }
        }
        expect(mismatchResponse).toMatchObject({
          code: "protocol_version_mismatch",
          details: { retryUpdate: true, serverProtocolVersion: 261 },
        });
        expect(openedProtocols).toEqual([260, installedProtocolVersion]);
        expect(installed).toHaveLength(1);
        expect(installedCallbackCount).toBe(
          installedProtocolVersion === 261 ? 1 : 0,
        );
        if (installedProtocolVersion === 261) {
          expect(session?.sessionId).toBeTruthy();
          expect(startError).toBeUndefined();
        } else {
          expect(session).toBeUndefined();
          expect(startError).toBeUndefined();
        }
        expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(261);
      } finally {
        await connection.shutdown();
        await server.close();
      }
    },
  );
});
