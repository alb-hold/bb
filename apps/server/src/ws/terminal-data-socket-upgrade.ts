import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  TERMINAL_DATA_SOCKET_PATH,
  TERMINAL_DATA_SOCKET_TICKET_HEADER,
} from "@bb/host-daemon-contract";
import {
  requestHostProblem,
  type BrowserRequestGuardDeps,
} from "../browser-request-guard.js";
import type { TerminalDataTicketBinding } from "../services/terminals/data-plane/terminal-data-ticket-store.js";
import type { TerminalDataPlaneHandoffRequest } from "../terminal-data-plane/ipc-contract.js";

const HANDSHAKE_HEADERS = new Set([
  "connection",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "upgrade",
]);

const REFUSAL_BACKSTOP_MS = 2_000;

const REFUSALS = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  503: "Service Unavailable",
} as const;

export interface TerminalDataSocketAttachArgs {
  daemonSessionId: string;
  request: TerminalDataPlaneHandoffRequest;
  socket: Socket;
}

export interface TerminalDataSocketUpgradeOptions {
  attach(args: TerminalDataSocketAttachArgs): boolean;
  currentSessionIdForHost(hostId: string): string | null;
  guard: BrowserRequestGuardDeps;
  redeemTicket(ticket: string): TerminalDataTicketBinding | null;
  verifyDaemon(
    authorizationHeader: string | undefined,
  ): Promise<{ hostId: string }>;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function handshakeHeaderPairs(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (
      name !== undefined &&
      value !== undefined &&
      HANDSHAKE_HEADERS.has(name.toLowerCase())
    ) {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

function refuse(socket: Duplex, status: keyof typeof REFUSALS): void {
  if (socket.destroyed) {
    return;
  }
  const backstop = setTimeout(() => socket.destroy(), REFUSAL_BACKSTOP_MS);
  backstop.unref();
  socket.once("finish", () => socket.destroy());
  socket.once("close", () => clearTimeout(backstop));
  socket.end(
    `HTTP/1.1 ${status} ${REFUSALS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function admit(
  options: TerminalDataSocketUpgradeOptions,
  args: {
    authorizationHeader: string | undefined;
    binding: TerminalDataTicketBinding;
    request: TerminalDataPlaneHandoffRequest;
    socket: Duplex;
  },
): Promise<void> {
  let hostId: string;
  try {
    hostId = (await options.verifyDaemon(args.authorizationHeader)).hostId;
  } catch {
    refuse(args.socket, 401);
    return;
  }
  if (
    hostId !== args.binding.hostId ||
    options.currentSessionIdForHost(hostId) !== args.binding.daemonSessionId
  ) {
    refuse(args.socket, 403);
    return;
  }
  if (args.socket.destroyed) {
    return;
  }
  const attached = options.attach({
    daemonSessionId: args.binding.daemonSessionId,
    request: args.request,
    socket: args.socket as Socket,
  });
  if (!attached) {
    refuse(args.socket, 503);
  }
}

export function handleTerminalDataSocketUpgrade(
  options: TerminalDataSocketUpgradeOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://terminal-data.invalid");
  } catch {
    return false;
  }
  if (url.pathname !== TERMINAL_DATA_SOCKET_PATH) {
    return false;
  }
  socket.on("error", () => undefined);
  const host = headerValue(request, "host");
  if (
    request.method !== "GET" ||
    host === undefined ||
    headerValue(request, "upgrade")?.toLowerCase() !== "websocket"
  ) {
    refuse(socket, 400);
    return true;
  }
  const context = {
    req: {
      url: `http://${host}${url.pathname}`,
      method: "GET",
      header: (name: string) => headerValue(request, name.toLowerCase()),
    },
  };
  let hostRefused = true;
  try {
    hostRefused = requestHostProblem(context, options.guard) !== null;
  } catch {
    hostRefused = true;
  }
  if (hostRefused || headerValue(request, "origin") !== undefined) {
    refuse(socket, 403);
    return true;
  }
  const ticket = headerValue(request, TERMINAL_DATA_SOCKET_TICKET_HEADER);
  const binding = ticket === undefined ? null : options.redeemTicket(ticket);
  if (binding === null) {
    refuse(socket, 401);
    return true;
  }
  void admit(options, {
    authorizationHeader: headerValue(request, "authorization"),
    binding,
    request: {
      url: url.pathname,
      headers: handshakeHeaderPairs(request),
      headBase64: head.toString("base64"),
    },
    socket,
  }).catch(() => refuse(socket, 503));
  return true;
}
