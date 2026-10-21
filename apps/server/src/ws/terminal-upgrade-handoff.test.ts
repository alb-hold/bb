import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTerminalUpgradeHandoff,
  type TerminalUpgradeHandoffOptions,
} from "./terminal-upgrade-handoff.js";

const servers: Server[] = [];
const clients: Socket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

interface Fixture {
  attach: ReturnType<typeof vi.fn>;
  fallback: ReturnType<typeof vi.fn>;
  port: number;
}

async function createFixture(
  overrides: Partial<TerminalUpgradeHandoffOptions> = {},
  attachResult: string | null = "attach_1",
): Promise<Fixture> {
  const server = createServer();
  servers.push(server);
  const fallback = vi.fn((_request, socket: Socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on("upgrade", fallback);
  const attach = vi.fn((args: { socket: Socket }) => {
    args.socket.destroy();
    return attachResult;
  });
  installTerminalUpgradeHandoff(server, {
    attach,
    guard: {
      config: { serverPort: 3001, appUrl: undefined, devAppPort: undefined },
    },
    handleDataSocketUpgrade: () => false,
    isAvailable: () => true,
    resolveTerminal: (terminalId) =>
      terminalId === "term_1"
        ? { terminalId, daemonSessionId: "ds_1", sequenceBase: 0 }
        : null,
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { attach, fallback, port: (server.address() as AddressInfo).port };
}

async function upgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const client = connect(port, "127.0.0.1");
  clients.push(client);
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  client.write(lines.join("\r\n"));
  await new Promise<void>((resolve) => {
    client.on("close", () => resolve());
    client.on("error", () => resolve());
    setTimeout(resolve, 300);
  });
}

describe("installTerminalUpgradeHandoff", () => {
  it("hands an authorized terminal upgrade to the data plane with the id from the path", async () => {
    const { attach, fallback, port } = await createFixture();
    await upgrade(
      port,
      "/ws/terminals/term_1?outputAcks=1&sinceSeq=5&handoffOwnerToken=0123456789abcdefghij_-",
    );
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0]?.[0]).toMatchObject({
      daemonSessionId: "ds_1",
      handoffOwnerToken: "0123456789abcdefghij_-",
      outputAcks: true,
      sinceSeq: 5,
      terminalId: "term_1",
      request: { url: "/ws/terminals/term_1?outputAcks=1&sinceSeq=5" },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("leaves forbidden origins, bad queries, unknown terminals and other paths to the in-process path", async () => {
    const { attach, fallback, port } = await createFixture();
    await upgrade(port, "/ws/terminals/term_1", {
      Origin: "https://evil.example",
    });
    await upgrade(port, "/ws/terminals/term_1?sinceSeq=-1");
    await upgrade(port, "/ws/terminals/term_unknown");
    await upgrade(port, "/ws");
    await upgrade(port, "/internal/ws");
    expect(attach).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(5);
  });

  it("falls back when the data plane is unavailable or refuses the socket", async () => {
    const unavailable = await createFixture({ isAvailable: () => false });
    await upgrade(unavailable.port, "/ws/terminals/term_1");
    expect(unavailable.attach).not.toHaveBeenCalled();
    expect(unavailable.fallback).toHaveBeenCalledTimes(1);

    const refused = await createFixture({}, null);
    await upgrade(refused.port, "/ws/terminals/term_1");
    expect(refused.attach).toHaveBeenCalledTimes(1);
    expect(refused.fallback).toHaveBeenCalledTimes(1);
  });
});
