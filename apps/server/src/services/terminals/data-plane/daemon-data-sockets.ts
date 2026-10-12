import type { Socket } from "node:net";
import {
  TERMINAL_DATA_SOCKET_PATH,
  terminalDataPlaneConnectResultSchema,
} from "@bb/host-daemon-contract";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneHandoffRequest,
} from "../../../terminal-data-plane/ipc-contract.js";
import type {
  DaemonCapabilityRpcPort,
  DaemonDataPlaneCapabilities,
} from "./daemon-capability.js";
import type { DataPlaneTransport } from "./data-plane-router.js";
import type { TerminalDataTicketStore } from "./terminal-data-ticket-store.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

export const DAEMON_DATA_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const DAEMON_DATA_SOCKET_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 60_000, 60_000,
];
export const DAEMON_DATA_SOCKET_STABLE_MS = 60_000;

export type DaemonSessionChange =
  | { kind: "opened"; hostId: string; sessionId: string }
  | { kind: "closed"; sessionId: string };

export interface DaemonDataSocketsOptions {
  capabilities: Pick<DaemonDataPlaneCapabilities, "forget" | "negotiate">;
  connectTimeoutMs?: number;
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  newRequestId: () => string;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  rpc: DaemonCapabilityRpcPort;
  setSessionDirectOutput(args: {
    daemonSessionId: string;
    enabled: boolean;
  }): void;
  tickets: TerminalDataTicketStore;
  transport: DataPlaneTransport;
}

interface SessionEntry {
  attachedAt: number | null;
  attempts: number;
  generation: number;
  hostId: string;
  retryTimer: NodeJS.Timeout | null;
  routedTerminalIds: Set<string>;
}

export class DaemonDataSockets {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly options: DaemonDataSocketsOptions) {}

  isAttached(daemonSessionId: string): boolean {
    const entry = this.sessions.get(daemonSessionId);
    return entry !== undefined && entry.attachedAt !== null;
  }

  routeTerminal(args: { daemonSessionId: string; terminalId: string }): boolean {
    const entry = this.sessions.get(args.daemonSessionId);
    if (entry === undefined || entry.attachedAt === null) {
      return false;
    }
    entry.routedTerminalIds.add(args.terminalId);
    return this.options.transport.send({
      v: V,
      type: "terminal.route",
      terminalId: args.terminalId,
      daemonSessionId: args.daemonSessionId,
      mode: "data-socket",
    });
  }

  unrouteTerminal(terminalId: string): void {
    for (const entry of this.sessions.values()) {
      if (entry.routedTerminalIds.delete(terminalId)) {
        this.options.transport.send({ v: V, type: "terminal.unroute", terminalId });
      }
    }
  }

  attachSocket(args: {
    daemonSessionId: string;
    request: TerminalDataPlaneHandoffRequest;
    socket: Socket;
  }): boolean {
    if (!this.sessions.has(args.daemonSessionId)) {
      return false;
    }
    return this.options.transport.send(
      {
        v: V,
        type: "daemon.attach",
        daemonSessionId: args.daemonSessionId,
        request: args.request,
      },
      { handle: args.socket },
    );
  }

  handleSessionChange(change: DaemonSessionChange): void {
    if (change.kind === "closed") {
      this.closeSession(change.sessionId);
      return;
    }
    const existing = this.sessions.get(change.sessionId);
    if (existing !== undefined) {
      return;
    }
    this.sessions.set(change.sessionId, {
      attachedAt: null,
      attempts: 0,
      generation: 0,
      hostId: change.hostId,
      retryTimer: null,
      routedTerminalIds: new Set(),
    });
    if (this.options.transport.isReady) {
      this.startNegotiation(change.sessionId);
    }
  }

  handleChildReady(): void {
    for (const daemonSessionId of this.sessions.keys()) {
      this.startNegotiation(daemonSessionId);
    }
  }

  handleChildDown(): void {
    for (const [daemonSessionId, entry] of this.sessions) {
      entry.generation += 1;
      entry.attempts = 0;
      entry.routedTerminalIds.clear();
      this.clearRetry(entry);
      this.options.tickets.revoke(daemonSessionId);
      this.markDetached(daemonSessionId, entry);
    }
  }

  handleChildMessage(message: TerminalDataPlaneChildMessage): void {
    if (message.type === "daemon.attached") {
      const entry = this.sessions.get(message.daemonSessionId);
      if (entry === undefined) {
        this.options.transport.send({
          v: V,
          type: "daemon.detach",
          daemonSessionId: message.daemonSessionId,
        });
        return;
      }
      entry.attachedAt = this.now();
      this.clearRetry(entry);
      this.options.logger.info(
        { daemonSessionId: message.daemonSessionId, hostId: entry.hostId },
        "Terminal data socket attached; this host's terminals bypass the server's main thread",
      );
      this.options.setSessionDirectOutput({
        daemonSessionId: message.daemonSessionId,
        enabled: true,
      });
      return;
    }
    if (message.type !== "daemon.detached") {
      return;
    }
    const entry = this.sessions.get(message.daemonSessionId);
    if (entry === undefined) {
      return;
    }
    if (
      entry.attachedAt !== null &&
      this.now() - entry.attachedAt >= DAEMON_DATA_SOCKET_STABLE_MS
    ) {
      entry.attempts = 0;
    }
    this.options.logger.info(
      { daemonSessionId: message.daemonSessionId, hostId: entry.hostId },
      "Terminal data socket detached; this host's terminals use the server connection",
    );
    this.unrouteSession(entry);
    this.markDetached(message.daemonSessionId, entry);
    this.scheduleRetry(message.daemonSessionId, entry);
  }

  stop(): void {
    for (const entry of this.sessions.values()) {
      entry.generation += 1;
      this.clearRetry(entry);
    }
    this.sessions.clear();
  }

  private closeSession(daemonSessionId: string): void {
    const entry = this.sessions.get(daemonSessionId);
    if (entry === undefined) {
      return;
    }
    entry.generation += 1;
    this.clearRetry(entry);
    this.sessions.delete(daemonSessionId);
    this.options.tickets.revoke(daemonSessionId);
    this.options.capabilities.forget(daemonSessionId);
    this.unrouteSession(entry);
    this.options.transport.send({ v: V, type: "daemon.detach", daemonSessionId });
    this.markDetached(daemonSessionId, entry);
  }

  private markDetached(daemonSessionId: string, entry: SessionEntry): void {
    entry.attachedAt = null;
    this.options.setSessionDirectOutput({ daemonSessionId, enabled: false });
  }

  private unrouteSession(entry: SessionEntry): void {
    for (const terminalId of entry.routedTerminalIds) {
      this.options.transport.send({ v: V, type: "terminal.unroute", terminalId });
    }
    entry.routedTerminalIds.clear();
  }

  private clearRetry(entry: SessionEntry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
  }

  private scheduleRetry(daemonSessionId: string, entry: SessionEntry): void {
    const delays =
      this.options.retryDelaysMs ?? DAEMON_DATA_SOCKET_RETRY_DELAYS_MS;
    const delay = delays[entry.attempts];
    if (entry.retryTimer !== null || entry.attachedAt !== null) {
      return;
    }
    if (delay === undefined) {
      this.options.logger.warn(
        { daemonSessionId, hostId: entry.hostId },
        "Terminal data socket keeps failing; this host's terminals stay on the server connection",
      );
      return;
    }
    entry.attempts += 1;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.startNegotiation(daemonSessionId);
    }, delay);
    entry.retryTimer.unref();
  }

  private startNegotiation(daemonSessionId: string): void {
    this.negotiate(daemonSessionId).catch((error: unknown) => {
      this.options.logger.warn(
        { daemonSessionId, err: error },
        "Terminal data socket negotiation failed; terminals stay on the server connection",
      );
    });
  }

  private async negotiate(daemonSessionId: string): Promise<void> {
    const entry = this.sessions.get(daemonSessionId);
    if (entry === undefined || entry.attachedAt !== null) {
      return;
    }
    entry.generation += 1;
    const generation = entry.generation;
    const isCurrent = () =>
      this.sessions.get(daemonSessionId) === entry &&
      entry.generation === generation;
    const mode = await this.options.capabilities.negotiate({
      daemonSessionId,
      hostId: entry.hostId,
    });
    if (!isCurrent() || !this.options.transport.isReady) {
      return;
    }
    if (mode !== "data-socket") {
      this.scheduleRetry(daemonSessionId, entry);
      return;
    }
    const ticket = this.options.tickets.issue({
      daemonSessionId,
      hostId: entry.hostId,
    });
    let connected = false;
    try {
      const response = await this.options.rpc.request({
        hostId: entry.hostId,
        message: {
          type: "host-rpc.request",
          requestId: this.options.newRequestId(),
          command: {
            type: "terminal-data-plane.connect",
            url: TERMINAL_DATA_SOCKET_PATH,
            ticket,
          },
        },
        timeoutMs:
          this.options.connectTimeoutMs ?? DAEMON_DATA_SOCKET_CONNECT_TIMEOUT_MS,
      });
      const result = response.ok
        ? terminalDataPlaneConnectResultSchema.safeParse(response.result)
        : null;
      connected = result?.success === true && result.data.connected;
    } catch {
      connected = false;
    }
    if (!isCurrent()) {
      return;
    }
    this.options.tickets.revoke(daemonSessionId);
    if (!connected) {
      this.scheduleRetry(daemonSessionId, entry);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
