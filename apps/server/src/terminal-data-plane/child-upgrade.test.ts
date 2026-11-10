import { once } from "node:events";
import { createServer } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTerminalDataPlaneUpgrade } from "./child-upgrade.js";

describe("terminal data plane protocol negotiation", () => {
  it.each([
    [["bb.terminal.v1"], "bb.terminal.v1"],
    [
      ["bb.terminal.v1", "bb.terminal.resize-echo.v1"],
      "bb.terminal.resize-echo.v1",
    ],
    [
      [
        "bb.terminal.v1",
        "bb.terminal.resize-echo.v1",
        "bb.terminal.replay-batch.v1",
      ],
      "bb.terminal.replay-batch.v1",
    ],
  ] as const)("negotiates %j as %s", async (offered, selected) => {
    const server = createServer();
    const upgrade = createTerminalDataPlaneUpgrade();
    const accepted: WebSocket[] = [];
    server.on("upgrade", (request, socket, head) => {
      if (!(socket instanceof Socket)) throw new Error("Expected a TCP socket");
      void upgrade(
        {
          url: request.url ?? "/",
          headers: Object.entries(request.headers).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value] as [string, string]] : [],
          ),
          headBase64: head.toString("base64"),
        },
        socket,
      ).then((webSocket) => {
        accepted.push(webSocket);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/terminals/test`,
      [...offered],
    );
    try {
      await once(client, "open");
      expect(client.protocol).toBe(selected);
    } finally {
      client.terminate();
      for (const socket of accepted) socket.terminate();
      server.close();
      server.unref();
    }
  });
});
