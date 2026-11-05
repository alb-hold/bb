import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL } from "@bb/server-contract";
import type { TerminalDataPlaneHandoffRequest } from "./ipc-contract.js";

export const TERMINAL_DATA_PLANE_MAX_FRAME_BYTES = 1024 * 1024;

function toIncomingHeaders(
  pairs: TerminalDataPlaneHandoffRequest["headers"],
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    const existing = headers[key];
    headers[key] =
      typeof existing === "string" ? `${existing}, ${value}` : value;
  }
  return headers;
}

export function createTerminalDataPlaneUpgrade(): (
  request: TerminalDataPlaneHandoffRequest,
  socket: Socket,
) => Promise<WebSocket> {
  const server = new WebSocketServer({
    handleProtocols: (protocols) =>
      protocols.has(TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL)
        ? TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL
        : (protocols.values().next().value ?? false),
    maxPayload: TERMINAL_DATA_PLANE_MAX_FRAME_BYTES,
    noServer: true,
    perMessageDeflate: false,
  });
  return (request, socket) =>
    new Promise((resolve, reject) => {
      const incoming = new IncomingMessage(socket);
      incoming.method = "GET";
      incoming.url = request.url;
      incoming.headers = toIncomingHeaders(request.headers);
      const onClose = (): void => {
        reject(new Error("The socket closed during the WebSocket upgrade"));
      };
      socket.once("close", onClose);
      server.handleUpgrade(
        incoming,
        socket,
        Buffer.from(request.headBase64, "base64"),
        (webSocket) => {
          socket.off("close", onClose);
          resolve(webSocket);
        },
      );
    });
}
