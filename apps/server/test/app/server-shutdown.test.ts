import { once } from "node:events";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  shutdownHttpBeforePlugins,
  startHttpListener,
} from "../../src/start-server.js";
import { closeWebSocketServer } from "../../src/server.js";

type ShutdownHttpBeforePlugins = (args: {
  closeDatabase?: () => void;
  closeWebSockets: () => Promise<void>;
  server: ReturnType<typeof startHttpListener>;
  stopPlugins: () => Promise<void>;
  stopTerminalDataPlane: () => void;
}) => Promise<{ completedWithinBounds: boolean; pluginStopTimedOut: boolean }>;

describe("server shutdown ordering", () => {
  let server: ReturnType<typeof startHttpListener> | undefined;
  let db: DbConnection | undefined;
  let webSocketServer: WebSocketServer | undefined;
  let webSocketClient: WebSocket | undefined;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
  });

  afterEach(async () => {
    webSocketClient?.terminate();
    if (webSocketServer !== undefined) {
      for (const socket of webSocketServer.clients) socket.terminate();
      await new Promise<void>((resolve) =>
        webSocketServer?.close(() => resolve()),
      );
    }
    server?.closeAllConnections();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
    webSocketServer = undefined;
    webSocketClient = undefined;
    db?.$client.close();
    db = undefined;
  });

  it("keeps an in-flight pooled plugin request available until the listener drains", async () => {
    let releaseRequest: (() => void) | undefined;
    let stopStarted = false;
    server = startHttpListener({
      fetch: async (request) => {
        if (
          new URL(request.url).pathname !==
          "/api/v1/plugins/account-pool/http/v1/responses"
        ) {
          return new Response(null, { status: 404 });
        }
        await new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        if (stopStarted) return new Response("plugin stopped", { status: 503 });
        return new Response("served while shutting down");
      },
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    const request = fetch(
      `http://127.0.0.1:${address.port}/api/v1/plugins/account-pool/http/v1/responses`,
    );
    while (releaseRequest === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const stopPlugins = async () => {
      stopStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const currentModule = (await import("../../src/start-server.js")) as {
      shutdownHttpBeforePlugins?: ShutdownHttpBeforePlugins;
    };
    const shutdown = currentModule.shutdownHttpBeforePlugins
      ? currentModule.shutdownHttpBeforePlugins({
          closeWebSockets: async () => {},
          server,
          stopPlugins,
          stopTerminalDataPlane: () => {},
        })
      : (async () => {
          await stopPlugins();
          await new Promise<void>((resolve, reject) => {
            server?.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          return { completedWithinBounds: true, pluginStopTimedOut: false };
        })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseRequest();
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("served while shutting down");
    await shutdown;
    expect(stopStarted).toBe(true);
  });

  it("bounds shutdown when an HTTP response stream stays open", async () => {
    server = startHttpListener({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        ),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/stream`);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("stream response had no body");
    }
    await reader.read();
    const startedAt = Date.now();
    await shutdownHttpBeforePlugins({
      closeWebSockets: async () => {},
      server,
      stopPlugins: async () => {},
      stopTerminalDataPlane: () => {},
    });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await reader.cancel().catch(() => {});
  }, 5_000);

  it("bounds plugin shutdown after the HTTP listener closes", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    let pluginStopStartedAfterHttpClosed = false;
    const startedAt = Date.now();
    await shutdownHttpBeforePlugins({
      closeWebSockets: async () => {},
      server,
      stopPlugins: () => {
        pluginStopStartedAfterHttpClosed = !server?.listening;
        return new Promise<void>(() => {});
      },
      stopTerminalDataPlane: () => {},
    });
    expect(pluginStopStartedAfterHttpClosed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 4_500);

  it("skips database close when a plugin stop never resolves", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    let databaseClosed = false;
    let pluginObservedDatabaseError: unknown;
    let pluginProbe: ReturnType<typeof setInterval> | undefined;
    const shutdown = shutdownHttpBeforePlugins({
      closeDatabase: () => {
        databaseClosed = true;
        db?.$client.close();
      },
      closeWebSockets: async () => {},
      server,
      stopPlugins: () => {
        pluginProbe = setInterval(() => {
          try {
            db?.$client.prepare("SELECT 1").get();
          } catch (error) {
            pluginObservedDatabaseError = error;
          }
        }, 25);
        return new Promise<void>(() => {});
      },
      stopTerminalDataPlane: () => {},
    });
    const result = await shutdown;
    if (result?.pluginStopTimedOut !== true) {
      databaseClosed = true;
      db?.$client.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (pluginProbe !== undefined) clearInterval(pluginProbe);
    expect(pluginObservedDatabaseError, "plugin database read failed after shutdown began").toBeUndefined();
    expect(result?.pluginStopTimedOut).toBe(true);
    expect(result?.completedWithinBounds).toBe(false);
    expect(databaseClosed).toBe(false);
    expect(pluginObservedDatabaseError).toBeUndefined();
    expect(db?.$client.prepare("SELECT 1").get()).toBeDefined();
  }, 4_500);

  it("stops accepting before a stalled plugin update check and bounds shutdown", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    let updateCheckStarted: (() => void) | undefined;
    const updateCheckEntered = new Promise<void>((resolve) => {
      updateCheckStarted = resolve;
    });
    let pluginStopCalled = false;
    let pluginStopStartedAt = Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    const shutdown = shutdownHttpBeforePlugins({
      closeWebSockets: async () => {},
      server,
      stopPeriodicUpdateChecks: () => {
        updateCheckStarted?.();
        return new Promise<void>(() => {});
      },
      stopPlugins: async () => {
        pluginStopCalled = true;
        pluginStopStartedAt = Date.now();
      },
      stopTerminalDataPlane: () => {},
    });
    await updateCheckEntered;
    await expect(fetch(`http://127.0.0.1:${address.port}/new`)).rejects.toThrow();
    expect(pluginStopCalled).toBe(true);
    expect(pluginStopStartedAt - startedAt).toBeLessThan(1_000);
    await shutdown;
    expect(server.listening).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_800);
  }, 6_000);

  it("stops accepting HTTP before closing WebSocket clients", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    await once(server, "listening");
    let listenerClosedBeforeWebSockets = false;
    await shutdownHttpBeforePlugins({
      closeWebSockets: async () => {
        listenerClosedBeforeWebSockets = !server?.listening;
      },
      server,
      stopPlugins: async () => {},
      stopTerminalDataPlane: () => {},
    });
    expect(listenerClosedBeforeWebSockets).toBe(true);
  });

  it("bounds shutdown when a WebSocket client ignores the close request", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer?.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer?.emit("connection", webSocket, request);
      });
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    const accepted = once(webSocketServer, "connection");
    webSocketClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(webSocketClient, "open");
    const [webSocket] = (await accepted) as [WebSocket];
    webSocket.close = (() => webSocket) as WebSocket["close"];
    let pluginsStoppedAfterHttpClosed = false;
    const startedAt = Date.now();
    await shutdownHttpBeforePlugins({
      closeWebSockets: () =>
        closeWebSocketServer({
          forceCloseAfterMs: 1_000,
          reason: "server-shutdown",
          server: webSocketServer!,
        }),
      server,
      stopPlugins: async () => {
        pluginsStoppedAfterHttpClosed = !server?.listening;
      },
      stopTerminalDataPlane: () => {},
    });
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(pluginsStoppedAfterHttpClosed).toBe(true);
  }, 4_000);

  it("stops accepting before plugin stop and bounds an upgraded plugin socket", async () => {
    server = startHttpListener({
      fetch: async () => new Response("ready"),
      logger: { warn: () => {} },
      serverConfig: {
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: 0,
      },
    });
    webSocketServer = new WebSocketServer({ noServer: true });
    let upgradedSocket: { destroyed: boolean } | undefined;
    server.on("upgrade", (request, socket, head) => {
      upgradedSocket = socket;
      webSocketServer?.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer?.emit("connection", webSocket, request);
      });
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    const accepted = once(webSocketServer, "connection");
    webSocketClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(webSocketClient, "open");
    const [pluginSocket] = (await accepted) as [WebSocket];
    let pluginStopCalled = false;
    let acceptedAfterPluginStop = true;
    let upgradedSocketDestroyedAtPluginStop = false;
    const startedAt = Date.now();
    const shutdown = shutdownHttpBeforePlugins({
      closeWebSockets: () => new Promise<void>(() => {}),
      server,
      stopPlugins: async () => {
        pluginStopCalled = true;
        acceptedAfterPluginStop = server!.listening;
        upgradedSocketDestroyedAtPluginStop = upgradedSocket?.destroyed ?? false;
        pluginSocket.terminate();
        await new Promise<void>(() => {});
      },
      stopTerminalDataPlane: () => {},
    });
    await expect(fetch(`http://127.0.0.1:${address.port}/new`)).rejects.toThrow();
    expect(pluginStopCalled).toBe(false);
    await shutdown;
    expect(pluginStopCalled).toBe(true);
    expect(acceptedAfterPluginStop).toBe(false);
    expect(upgradedSocketDestroyedAtPluginStop).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_800);
  }, 6_000);
});
