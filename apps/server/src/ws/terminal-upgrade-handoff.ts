import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import {
  browserRequestProblem,
  requestHostProblem,
  type BrowserRequestGuardDeps,
} from "../browser-request-guard.js";
import type { DataPlaneAttachArgs } from "../services/terminals/data-plane/data-plane-router.js";

const TERMINAL_SOCKET_PATH = /^\/ws\/terminals\/([^/]+)$/u;

export interface TerminalUpgradeTarget {
  daemonSessionId: string;
  terminalId: string;
}

export interface TerminalUpgradeHandoffOptions {
  attach(args: DataPlaneAttachArgs): string | null;
  guard: BrowserRequestGuardDeps;
  handleDataSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean;
  isAvailable(): boolean;
  resolveTerminal(terminalId: string): TerminalUpgradeTarget | null;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rawHeaderPairs(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

export function handOffTerminalUpgrade(
  options: TerminalUpgradeHandoffOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  if (!options.isAvailable() || request.url === undefined) {
    return false;
  }
  if (headerValue(request, "upgrade")?.toLowerCase() !== "websocket") {
    return false;
  }
  const host = headerValue(request, "host");
  if (host === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(request.url, `http://${host}`);
  } catch {
    return false;
  }
  const match = TERMINAL_SOCKET_PATH.exec(url.pathname);
  if (match === null) {
    return false;
  }
  let terminalId: string;
  try {
    terminalId = decodeURIComponent(match[1] ?? "");
  } catch {
    return false;
  }
  const context = {
    req: {
      url: url.href,
      method: request.method ?? "GET",
      header: (name: string) => headerValue(request, name.toLowerCase()),
    },
  };
  if (
    requestHostProblem(context, options.guard) !== null ||
    browserRequestProblem(context, options.guard) !== null
  ) {
    return false;
  }
  const query = terminalWebSocketQuerySchema.safeParse({
    outputAcks: url.searchParams.get("outputAcks") ?? undefined,
    sinceSeq: url.searchParams.get("sinceSeq") ?? undefined,
  });
  if (!query.success) {
    return false;
  }
  const target = options.resolveTerminal(terminalId);
  if (target === null || target.terminalId !== terminalId) {
    return false;
  }
  const attachId = options.attach({
    daemonSessionId: target.daemonSessionId,
    outputAcks: query.data.outputAcks,
    request: {
      url: `${url.pathname}${url.search}`,
      headers: rawHeaderPairs(request),
      headBase64: head.toString("base64"),
    },
    sinceSeq: query.data.sinceSeq,
    socket: socket as Socket,
    terminalId,
  });
  return attachId !== null;
}

export function installTerminalUpgradeHandoff(
  server: Server,
  options: TerminalUpgradeHandoffOptions,
): void {
  const existing = server.listeners("upgrade") as Array<
    (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (request, socket, head) => {
    let handled = false;
    try {
      handled =
        options.handleDataSocketUpgrade(request, socket, head) ||
        handOffTerminalUpgrade(options, request, socket, head);
    } catch {
      handled = false;
    }
    if (handled) {
      return;
    }
    for (const listener of existing) {
      listener.call(server, request, socket, head);
    }
  });
}
