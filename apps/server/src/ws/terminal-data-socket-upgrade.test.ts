import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import {
  TERMINAL_DATA_SOCKET_PATH,
  TERMINAL_DATA_SOCKET_TICKET_HEADER,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDataTicketStore } from "../services/terminals/data-plane/terminal-data-ticket-store.js";
import {
  handleTerminalDataSocketUpgrade,
  type TerminalDataSocketAttachArgs,
} from "./terminal-data-socket-upgrade.js";

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

const HOST_KEYS: Record<string, string> = {
  "Bearer host-key-1": "host_1",
  "Bearer host-key-2": "host_2",
};

interface Fixture {
  attach: ReturnType<typeof vi.fn>;
  clock: { now: number };
  currentSessionId: { value: string | null };
  fallback: ReturnType<typeof vi.fn>;
  issue(hostId?: string, daemonSessionId?: string): string;
  port: number;
  serverSockets: Socket[];
  store: TerminalDataTicketStore;
}

async function createFixture(
  attachResult = true,
): Promise<Fixture> {
  const clock = { now: 1_000_000 };
  const store = new TerminalDataTicketStore(() => clock.now, 15_000);
  const currentSessionId: { value: string | null } = { value: "session_1" };
  const attach = vi.fn((args: TerminalDataSocketAttachArgs) => {
    if (attachResult) {
      args.socket.destroy();
    }
    return attachResult;
  });
  const fallback = vi.fn();
  const server = createServer();
  servers.push(server);
  const serverSockets: Socket[] = [];
  server.on("connection", (accepted) => serverSockets.push(accepted));
  server.on("upgrade", (request, socket, head) => {
    const handled = handleTerminalDataSocketUpgrade(
      {
        attach,
        currentSessionIdForHost: () => currentSessionId.value,
        guard: {
          config: {
            serverPort: 3001,
            appUrl: undefined,
            devAppPort: undefined,
          },
        },
        redeemTicket: (ticket) => store.redeem(ticket),
        verifyDaemon: async (header) => {
          const hostId = header === undefined ? undefined : HOST_KEYS[header];
          if (hostId === undefined) {
            throw new Error("unauthorized");
          }
          return { hostId };
        },
      },
      request,
      socket,
      head,
    );
    if (!handled) {
      fallback();
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    attach,
    clock,
    currentSessionId,
    fallback,
    issue: (hostId = "host_1", daemonSessionId = "session_1") =>
      store.issue({ daemonSessionId, hostId }),
    port: (server.address() as AddressInfo).port,
    serverSockets,
    store,
  };
}

interface Reply {
  status: number | null;
}

async function dial(
  port: number,
  options: {
    headers?: Record<string, string>;
    host?: string;
    method?: string;
    path?: string;
  } = {},
): Promise<Reply> {
  const client = connect({ allowHalfOpen: true, host: "127.0.0.1", port });
  clients.push(client);
  const lines = [
    `${options.method ?? "GET"} ${options.path ?? TERMINAL_DATA_SOCKET_PATH} HTTP/1.1`,
    `Host: ${options.host ?? `127.0.0.1:${port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...Object.entries(options.headers ?? {}).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    "",
    "",
  ];
  client.write(lines.join("\r\n"));
  let received = "";
  client.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  await new Promise<void>((resolve) => {
    client.on("close", () => resolve());
    client.on("error", () => resolve());
    setTimeout(resolve, 500);
  });
  const match = /^HTTP\/1\.1 (\d{3})/u.exec(received);
  return { status: match === null ? null : Number(match[1]) };
}

function authorized(
  ticket: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: "Bearer host-key-1",
    [TERMINAL_DATA_SOCKET_TICKET_HEADER]: ticket,
    ...extra,
  };
}

describe("terminal data socket upgrade", () => {
  it("admits a ticket redeemed by its own host key for its current session", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue()),
    });
    expect(reply.status).toBeNull();
    expect(fixture.attach).toHaveBeenCalledTimes(1);
    expect(fixture.attach.mock.calls[0]?.[0]).toMatchObject({
      daemonSessionId: "session_1",
    });
  });

  it("leaves other paths to the next upgrade listener", async () => {
    const fixture = await createFixture();
    await dial(fixture.port, { path: "/internal/other" });
    expect(fixture.fallback).toHaveBeenCalledTimes(1);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a request without a ticket", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: { authorization: "Bearer host-key-1" },
    });
    expect(reply.status).toBe(401);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a forged ticket", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized("forged-ticket-forged-ticket-forged-ticket"),
    });
    expect(reply.status).toBe(401);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses an expired ticket and forgets it", async () => {
    const fixture = await createFixture();
    const ticket = fixture.issue();
    fixture.clock.now += 15_000;
    const reply = await dial(fixture.port, { headers: authorized(ticket) });
    expect(reply.status).toBe(401);
    expect(fixture.store.size).toBe(0);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("still admits a ticket one millisecond before it expires", async () => {
    const fixture = await createFixture();
    const ticket = fixture.issue();
    fixture.clock.now += 14_999;
    await dial(fixture.port, { headers: authorized(ticket) });
    expect(fixture.attach).toHaveBeenCalledTimes(1);
  });

  it("refuses a replayed ticket", async () => {
    const fixture = await createFixture();
    const ticket = fixture.issue();
    await dial(fixture.port, { headers: authorized(ticket) });
    expect(fixture.attach).toHaveBeenCalledTimes(1);
    const replay = await dial(fixture.port, { headers: authorized(ticket) });
    expect(replay.status).toBe(401);
    expect(fixture.attach).toHaveBeenCalledTimes(1);
  });

  it("burns the ticket even when the host key is wrong", async () => {
    const fixture = await createFixture();
    const ticket = fixture.issue();
    const wrong = await dial(fixture.port, {
      headers: authorized(ticket, { authorization: "Bearer forged-key" }),
    });
    expect(wrong.status).toBe(401);
    const retry = await dial(fixture.port, { headers: authorized(ticket) });
    expect(retry.status).toBe(401);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a missing host key", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: { [TERMINAL_DATA_SOCKET_TICKET_HEADER]: fixture.issue() },
    });
    expect(reply.status).toBe(401);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a forged host key", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue(), { authorization: "Bearer nope" }),
    });
    expect(reply.status).toBe(401);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses another host's valid key presenting this host's ticket", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue("host_1"), {
        authorization: "Bearer host-key-2",
      }),
    });
    expect(reply.status).toBe(403);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a ticket whose daemon session is no longer the host's current session", async () => {
    const fixture = await createFixture();
    const ticket = fixture.issue("host_1", "session_1");
    fixture.currentSessionId.value = "session_2";
    const reply = await dial(fixture.port, { headers: authorized(ticket) });
    expect(reply.status).toBe(403);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a request that carries an Origin header", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue(), {
        origin: "http://127.0.0.1:3001",
      }),
    });
    expect(reply.status).toBe(403);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a Host header that is not local or the configured app host", async () => {
    const fixture = await createFixture();
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue()),
      host: "evil.example",
    });
    expect(reply.status).toBe(403);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("refuses a non-GET upgrade", async () => {
    const fixture = await createFixture();
    const post = await dial(fixture.port, {
      headers: authorized(fixture.issue()),
      method: "POST",
    });
    expect(post.status).toBe(400);
    expect(fixture.attach).not.toHaveBeenCalled();
  });

  it("destroys the server side of every refused socket although the client never closes its side", async () => {
    const fixture = await createFixture();
    await dial(fixture.port, { headers: { authorization: "Bearer host-key-1" } });
    await dial(fixture.port, {
      headers: authorized(fixture.issue(), { origin: "http://127.0.0.1:3001" }),
    });
    await dial(fixture.port, {
      headers: authorized(fixture.issue()),
      host: "evil.example",
    });
    await dial(fixture.port, {
      headers: authorized(fixture.issue()),
      method: "POST",
    });
    await dial(fixture.port, {
      headers: authorized(fixture.issue(), { authorization: "Bearer nope" }),
    });
    expect(fixture.serverSockets).toHaveLength(5);
    expect(fixture.serverSockets.map((socket) => socket.destroyed)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("destroys the server side of a socket answered 503", async () => {
    const fixture = await createFixture(false);
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue()),
    });
    expect(reply.status).toBe(503);
    expect(fixture.serverSockets.map((socket) => socket.destroyed)).toEqual([
      true,
    ]);
  });

  it("answers 503 when the data plane cannot take the socket", async () => {
    const fixture = await createFixture(false);
    const reply = await dial(fixture.port, {
      headers: authorized(fixture.issue()),
    });
    expect(reply.status).toBe(503);
  });
});
