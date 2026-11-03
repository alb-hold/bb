import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createCliBbSdk } from "../client.js";
import { createNativeActivityReporter } from "../native-activity-reporter.js";

interface StalledServer {
  baseUrl: string;
  closed: number[];
  received: number[];
  startedAt: number;
}

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function stalledFirstRequest(): Promise<StalledServer> {
  const state: StalledServer = {
    baseUrl: "",
    closed: [],
    received: [],
    startedAt: Date.now(),
  };
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const arrivedAt = Date.now() - state.startedAt;
      state.received.push(arrivedAt);
      request.resume();
      if (state.received.length === 1) {
        response.on("close", () =>
          state.closed.push(Date.now() - state.startedAt),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return state;
}

function reporterOver(baseUrl: string, requestTimeoutMs?: number) {
  const sdk = createCliBbSdk(baseUrl);
  return createNativeActivityReporter({
    currentCredential: () => "credential",
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    send: (args) => sdk.nativeTerminals.reportActivity(args),
    threadId: "thr_1",
  });
}

describe("native activity reporter over the production SDK client", () => {
  it("aborts a request the server never answers and delivers the next heartbeat", async () => {
    const server = await stalledFirstRequest();
    const reporter = reporterOver(server.baseUrl, 300);
    server.startedAt = Date.now();
    reporter.report({ state: "working", prompt: null }, { transient: true });
    reporter.report({ state: "working", prompt: null }, { transient: true });
    await reporter.settled();
    const elapsed = Date.now() - server.startedAt;
    expect(server.received).toHaveLength(2);
    expect(server.closed).toHaveLength(1);
    expect(server.closed[0]).toBeGreaterThanOrEqual(250);
    expect(server.closed[0]).toBeLessThan(2_000);
    expect(server.received[1]).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("gives up on a stalled request after about ten seconds, well before the next 30 second heartbeat", async () => {
    const server = await stalledFirstRequest();
    const reporter = reporterOver(server.baseUrl);
    server.startedAt = Date.now();
    reporter.report({ state: "working", prompt: null }, { transient: true });
    reporter.report({ state: "working", prompt: null }, { transient: true });
    await reporter.settled();
    expect(server.received).toHaveLength(2);
    expect(server.closed).toHaveLength(1);
    expect(server.closed[0]).toBeGreaterThanOrEqual(9_500);
    expect(server.closed[0]).toBeLessThan(12_000);
    expect(server.received[1]).toBeLessThan(30_000);
  }, 25_000);
});
