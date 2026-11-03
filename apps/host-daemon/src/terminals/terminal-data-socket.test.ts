import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TERMINAL_DATA_SOCKET_PATH,
  TERMINAL_DATA_SOCKET_TICKET_HEADER,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  TerminalDataSocket,
  type TerminalDataSocketInboundMessage,
  type TerminalDataSocketOptions,
  type TerminalDataSocketOutputMessage,
} from "./terminal-data-socket.js";

const TICKET = "ticket-ticket-ticket-ticket";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function output(seq: number, text = `chunk ${seq}`): TerminalDataSocketOutputMessage {
  return {
    type: "terminal.output",
    terminalId: "term_1",
    chunk: { seq, dataBase64: Buffer.from(text, "utf8").toString("base64") },
  };
}

interface Fixture {
  attached: number[];
  dataSocket: TerminalDataSocket;
  detached: number[];
  frames: unknown[];
  inbound: TerminalDataSocketInboundMessage[];
  requests: IncomingMessage[];
  serverSockets: WebSocket[];
}

async function createFixture(
  args: {
    autoPong?: boolean;
    options?: Partial<TerminalDataSocketOptions>;
    refuse?: boolean;
  } = {},
): Promise<Fixture> {
  const server: Server = createServer();
  const websocketServer = new WebSocketServer({
    autoPong: args.autoPong ?? true,
    noServer: true,
  });
  const requests: IncomingMessage[] = [];
  const serverSockets: WebSocket[] = [];
  const frames: unknown[] = [];
  server.on("upgrade", (request, socket, head) => {
    requests.push(request);
    if (args.refuse === true) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      serverSockets.push(websocket);
      websocket.on("message", (data) => {
        frames.push(JSON.parse(data.toString()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const attached: number[] = [];
  const detached: number[] = [];
  const inbound: TerminalDataSocketInboundMessage[] = [];
  const dataSocket = new TerminalDataSocket({
    hostKey: "host-key-1",
    logger: { info: () => undefined, warn: () => undefined },
    onAttached: () => attached.push(Date.now()),
    onDetached: () => detached.push(Date.now()),
    onMessage: (message) => inbound.push(message),
    serverHeaders: { "x-bb-connect-machine": "machine-credential" },
    serverUrl: `http://127.0.0.1:${port}/some/base?ignored=1`,
    ...args.options,
  });
  cleanups.push(() => {
    dataSocket.close();
    for (const socket of serverSockets) {
      socket.terminate();
    }
    websocketServer.close();
    server.closeAllConnections();
    server.close();
  });
  return {
    attached,
    dataSocket,
    detached,
    frames,
    inbound,
    requests,
    serverSockets,
  };
}

function connect(fixture: Fixture): Promise<boolean> {
  return fixture.dataSocket.connect({
    ticket: TICKET,
    url: TERMINAL_DATA_SOCKET_PATH,
  });
}

function serverSocket(fixture: Fixture, index = 0): WebSocket {
  const socket = fixture.serverSockets[index];
  if (socket === undefined) {
    throw new Error(`Server never saw data socket ${index}`);
  }
  return socket;
}

describe("terminal data socket", () => {
  it("dials only when told to, to this server's data path, with the host key and the ticket", async () => {
    const fixture = await createFixture();

    expect(fixture.dataSocket.sendOutput(output(0))).toBe(false);
    expect(
      await fixture.dataSocket.connect({
        ticket: TICKET,
        url: "ws://attacker.example/internal/terminal-data",
      }),
    ).toBe(false);
    expect(
      await fixture.dataSocket.connect({ ticket: TICKET, url: "/internal/ws" }),
    ).toBe(false);
    expect(fixture.requests).toHaveLength(0);

    expect(await connect(fixture)).toBe(true);

    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    expect(request?.url).toBe(TERMINAL_DATA_SOCKET_PATH);
    expect(request?.headers.authorization).toBe("Bearer host-key-1");
    expect(request?.headers[TERMINAL_DATA_SOCKET_TICKET_HEADER]).toBe(TICKET);
    expect(request?.headers["x-bb-connect-machine"]).toBe("machine-credential");
    expect(request?.headers.origin).toBeUndefined();
    expect(fixture.attached).toHaveLength(1);
    expect(fixture.dataSocket.isAttached).toBe(true);
  });

  it("carries output in order once attached and hands input, acks and flow control to the terminals", async () => {
    const fixture = await createFixture();
    expect(await connect(fixture)).toBe(true);

    expect(fixture.dataSocket.sendOutput(output(0))).toBe(true);
    expect(fixture.dataSocket.sendOutput(output(1))).toBe(true);
    expect(fixture.dataSocket.sendOutput(output(2))).toBe(true);
    await until(() => fixture.frames.length === 3, "the output frames");
    expect(fixture.frames).toEqual([output(0), output(1), output(2)]);

    const inbound: TerminalDataSocketInboundMessage[] = [
      { type: "terminal.flow-control", terminalId: "term_1", enabled: true },
      { type: "terminal.input", terminalId: "term_1", dataBase64: "bHM=" },
      { type: "terminal.ack", terminalId: "term_1", nextSeq: 3 },
    ];
    for (const message of inbound) {
      serverSocket(fixture).send(JSON.stringify(message));
    }
    await until(() => fixture.inbound.length === 3, "the inbound frames");
    expect(fixture.inbound).toEqual(inbound);
    expect(fixture.detached).toHaveLength(0);
  });

  it("closes itself on a message the data socket may not carry", async () => {
    const fixture = await createFixture();
    expect(await connect(fixture)).toBe(true);

    serverSocket(fixture).send(
      JSON.stringify({
        type: "terminal.close",
        terminalId: "term_1",
        reason: "user",
      }),
    );
    await until(() => fixture.detached.length === 1, "the detach");

    expect(fixture.inbound).toEqual([]);
    expect(fixture.dataSocket.isAttached).toBe(false);
    expect(fixture.dataSocket.sendOutput(output(0))).toBe(false);
  });

  it("reports a refused handshake as not connected and keeps output on the server connection", async () => {
    const fixture = await createFixture({ refuse: true });

    expect(await connect(fixture)).toBe(false);

    expect(fixture.attached).toHaveLength(0);
    expect(fixture.detached).toHaveLength(0);
    expect(fixture.dataSocket.sendOutput(output(0))).toBe(false);
  });

  it("stays off the data socket after it falls behind until the server asks again", async () => {
    const fixture = await createFixture({ options: { maxBufferedBytes: 0 } });
    expect(await connect(fixture)).toBe(true);
    const large = "x".repeat(8 * 1024 * 1024);

    expect(fixture.dataSocket.sendOutput(output(0, large))).toBe(true);
    expect(fixture.dataSocket.sendOutput(output(1, large))).toBe(false);

    expect(fixture.detached).toHaveLength(1);
    expect(fixture.dataSocket.sendOutput(output(2))).toBe(false);
    expect(fixture.dataSocket.sendOutput(output(3))).toBe(false);

    expect(await connect(fixture)).toBe(true);
    expect(fixture.attached).toHaveLength(2);
    expect(fixture.dataSocket.sendOutput(output(4))).toBe(true);
    await until(
      () => fixture.frames.some((frame) => JSON.stringify(frame) === JSON.stringify(output(4))),
      "output on the new data socket",
    );
    expect(fixture.frames).not.toContainEqual(output(2));
    expect(fixture.frames).not.toContainEqual(output(3));
  });

  it("returns output to the server connection when the server closes the data socket", async () => {
    const fixture = await createFixture();
    expect(await connect(fixture)).toBe(true);

    serverSocket(fixture).close(1001, "going away");
    await until(() => fixture.detached.length === 1, "the detach");

    expect(fixture.dataSocket.sendOutput(output(0))).toBe(false);
  });

  it("drops a data socket that stops answering pings", async () => {
    const fixture = await createFixture({
      autoPong: false,
      options: { pingIntervalMs: 20 },
    });
    expect(await connect(fixture)).toBe(true);

    await until(() => fixture.detached.length === 1, "the detach");

    expect(fixture.dataSocket.sendOutput(output(0))).toBe(false);
  });

  it("keeps a data socket that answers pings", async () => {
    const fixture = await createFixture({ options: { pingIntervalMs: 20 } });
    expect(await connect(fixture)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fixture.detached).toHaveLength(0);
    expect(fixture.dataSocket.sendOutput(output(0))).toBe(true);
  });

  it("replaces the previous data socket on a new connect and detaches once on close", async () => {
    const fixture = await createFixture();
    expect(await connect(fixture)).toBe(true);
    expect(await connect(fixture)).toBe(true);

    expect(fixture.attached).toHaveLength(2);
    expect(fixture.detached).toHaveLength(1);
    expect(fixture.dataSocket.sendOutput(output(0))).toBe(true);
    await until(() => fixture.frames.length === 1, "the output frame");

    fixture.dataSocket.close();
    fixture.dataSocket.close();

    expect(fixture.detached).toHaveLength(2);
    expect(fixture.dataSocket.sendOutput(output(1))).toBe(false);
  });
});
