import { once } from "node:events";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  shutdownHttpBeforePlugins,
  startHttpListener,
} from "../../src/start-server.js";

type ShutdownHttpBeforePlugins = (args: {
  closeWebSockets: () => Promise<void>;
  server: ReturnType<typeof startHttpListener>;
  stopPlugins: () => Promise<void>;
  stopTerminalDataPlane: () => void;
}) => Promise<void>;

describe("server shutdown ordering", () => {
  let server: ReturnType<typeof startHttpListener> | undefined;
  let db: DbConnection | undefined;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
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
});
