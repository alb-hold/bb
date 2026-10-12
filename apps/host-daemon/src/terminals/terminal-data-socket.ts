import {
  TERMINAL_DATA_SOCKET_PATH,
  TERMINAL_DATA_SOCKET_TICKET_HEADER,
  buildHostDaemonWebSocketAuthorizationHeader,
  hostDaemonServerWsMessageSchema,
  type HostDaemonDaemonWsMessage,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import { WebSocket } from "ws";
import type { TerminalDataSocketPort } from "../command-dispatch-support.js";
import type { HostDaemonLogger } from "../logger.js";
import { decodeWebSocketMessageData } from "../server-connection-support.js";

export const TERMINAL_DATA_SOCKET_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const TERMINAL_DATA_SOCKET_MAX_INBOUND_BYTES = 1024 * 1024;
export const TERMINAL_DATA_SOCKET_CONNECT_TIMEOUT_MS = 5_000;
export const TERMINAL_DATA_SOCKET_PING_INTERVAL_MS = 15_000;

export type TerminalDataSocketOutputMessage = Extract<
  HostDaemonDaemonWsMessage,
  { type: "terminal.output" }
>;

export type TerminalDataSocketInboundMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.input" | "terminal.ack" | "terminal.flow-control" }
>;

export interface TerminalDataSocketOptions {
  connectTimeoutMs?: number;
  hostKey: string;
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  maxBufferedBytes?: number;
  onAttached(): void;
  onDetached(): void;
  onMessage(message: TerminalDataSocketInboundMessage): void;
  pingIntervalMs?: number;
  serverHeaders: Record<string, string>;
  serverUrl: string;
}

function isInboundMessage(
  message: HostDaemonServerWsMessage,
): message is TerminalDataSocketInboundMessage {
  return (
    message.type === "terminal.input" ||
    message.type === "terminal.ack" ||
    message.type === "terminal.flow-control"
  );
}

export class TerminalDataSocket implements TerminalDataSocketPort {
  private active: WebSocket | null = null;
  private connecting: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  constructor(private readonly options: TerminalDataSocketOptions) {}

  get isAttached(): boolean {
    return this.active !== null;
  }

  connect(args: { ticket: string; url: string }): Promise<boolean> {
    if (args.url !== TERMINAL_DATA_SOCKET_PATH) {
      this.options.logger.warn(
        {},
        "Refused a terminal data socket target other than this server's data path",
      );
      return Promise.resolve(false);
    }
    this.close();
    const target = new URL(this.options.serverUrl);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = TERMINAL_DATA_SOCKET_PATH;
    target.search = "";
    target.hash = "";
    const socket = new WebSocket(target, {
      handshakeTimeout:
        this.options.connectTimeoutMs ?? TERMINAL_DATA_SOCKET_CONNECT_TIMEOUT_MS,
      headers: {
        authorization: buildHostDaemonWebSocketAuthorizationHeader(
          this.options.hostKey,
        ),
        ...this.options.serverHeaders,
        [TERMINAL_DATA_SOCKET_TICKET_HEADER]: args.ticket,
      },
      maxPayload: TERMINAL_DATA_SOCKET_MAX_INBOUND_BYTES,
      perMessageDeflate: false,
    });
    this.connecting = socket;
    return new Promise<boolean>((resolve) => {
      socket.once("open", () => {
        if (this.connecting !== socket) {
          socket.terminate();
          resolve(false);
          return;
        }
        this.connecting = null;
        this.active = socket;
        this.startPing(socket);
        this.options.logger.info({}, "Terminal data socket attached");
        this.options.onAttached();
        resolve(true);
      });
      socket.on("message", (data) => this.handleMessage(socket, data));
      socket.on("pong", () => {
        if (this.active === socket) {
          this.awaitingPong = false;
        }
      });
      socket.on("error", () => undefined);
      socket.once("close", () => {
        if (this.connecting === socket) {
          this.connecting = null;
        }
        this.release(socket);
        resolve(false);
      });
    });
  }

  sendOutput(message: TerminalDataSocketOutputMessage): boolean {
    const socket = this.active;
    if (socket === null) {
      return false;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      this.drop(socket);
      return false;
    }
    if (
      socket.bufferedAmount >
      (this.options.maxBufferedBytes ?? TERMINAL_DATA_SOCKET_MAX_BUFFERED_BYTES)
    ) {
      this.options.logger.warn(
        { bufferedBytes: socket.bufferedAmount },
        "Terminal data socket fell behind; terminal output returns to the server connection",
      );
      this.drop(socket);
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    const connecting = this.connecting;
    this.connecting = null;
    connecting?.terminate();
    const active = this.active;
    if (active !== null) {
      this.drop(active);
    }
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (this.active !== socket) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(decodeWebSocketMessageData(data));
    } catch {
      this.drop(socket);
      return;
    }
    const parsed = hostDaemonServerWsMessageSchema.safeParse(decoded);
    if (!parsed.success || !isInboundMessage(parsed.data)) {
      this.options.logger.warn(
        {},
        "Terminal data socket carried a message it may not carry; closing it",
      );
      this.drop(socket);
      return;
    }
    this.options.onMessage(parsed.data);
  }

  private startPing(socket: WebSocket): void {
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.active !== socket) {
        return;
      }
      if (this.awaitingPong) {
        this.options.logger.warn(
          {},
          "Terminal data socket stopped answering; terminal output returns to the server connection",
        );
        this.drop(socket);
        return;
      }
      this.awaitingPong = true;
      socket.ping();
    }, this.options.pingIntervalMs ?? TERMINAL_DATA_SOCKET_PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private drop(socket: WebSocket): void {
    socket.terminate();
    this.release(socket);
  }

  private release(socket: WebSocket): void {
    if (this.active !== socket) {
      return;
    }
    this.active = null;
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.options.onDetached();
  }
}
