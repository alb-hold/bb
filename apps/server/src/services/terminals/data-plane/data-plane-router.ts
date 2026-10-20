import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type {
  TerminalClientMessage,
  TerminalOutputChunk,
} from "@bb/server-contract";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneHandoffRequest,
  type TerminalDataPlaneMainMessage,
  type TerminalDataPlaneRouteMode,
} from "../../../terminal-data-plane/ipc-contract.js";
import {
  ChildTerminalSocket,
  type ChildTerminalBroadcastMessage,
  type ChildTerminalReplayFrame,
  type ChildTerminalReplyMessage,
  type ChildTerminalSocketSink,
} from "./child-terminal-socket.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

export interface DataPlaneTransport {
  readonly isReady: boolean;
  readonly pendingIpcBytes: number;
  send(
    message: TerminalDataPlaneMainMessage,
    options?: { bytes?: number; handle?: Socket },
  ): boolean;
}

export interface DataPlaneLifecyclePort {
  attach(args: {
    handoffOwnerToken?: string;
    outputAcks: boolean;
    resizeAcks: boolean;
    sinceSeq: number;
    socket: ChildTerminalSocket;
    terminalId: string;
  }): void;
  detach(args: { socket: ChildTerminalSocket; terminalId: string }): void;
  handleMessage(args: {
    message: TerminalClientMessage;
    socket: ChildTerminalSocket;
    terminalId: string;
  }): void;
  recordInputActivity(terminalId: string): void;
  stripHolderMarkersFromDataPlaneOutput(
    terminalId: string,
    chunk: TerminalOutputChunk,
  ): TerminalOutputChunk;
  recordOutputBatch(args: {
    chunks: TerminalOutputChunk[];
    daemonSessionId: string;
    terminalId: string;
  }): void;
}

interface PendingAttach {
  outputAcks: boolean;
  resizeAcks: boolean;
  sinceSeq: number;
  terminalId: string;
}

export interface DataPlaneAttachArgs {
  daemonSessionId: string;
  handoffOwnerToken?: string;
  outputAcks: boolean;
  resizeAcks: boolean;
  request: TerminalDataPlaneHandoffRequest;
  sinceSeq: number;
  socket: Socket;
  terminalId: string;
}

export class TerminalDataPlaneRouter implements ChildTerminalSocketSink {
  private readonly pending = new Map<string, PendingAttach>();
  private readonly handoffOwnerTokensByAttachId = new Map<string, string>();
  private readonly socketsByAttachId = new Map<string, ChildTerminalSocket>();
  private readonly attachIdsByTerminalId = new Map<string, Set<string>>();
  private readonly relayedSeqByTerminalId = new Map<string, number>();
  private readonly overloadedTerminalIds = new Set<string>();
  private lastBroadcastKey: string | null = null;

  constructor(
    private readonly transport: DataPlaneTransport,
    private readonly lifecycle: DataPlaneLifecyclePort,
    private readonly onTerminalExited: (terminalId: string) => void,
  ) {}

  get isAvailable(): boolean {
    return this.transport.isReady;
  }

  get attachedSocketCount(): number {
    return this.socketsByAttachId.size;
  }

  attachBrowser(args: DataPlaneAttachArgs): string | null {
    if (!this.transport.isReady) {
      return null;
    }
    const attachId = randomUUID();
    this.pending.set(attachId, {
      outputAcks: args.outputAcks,
      resizeAcks: args.resizeAcks,
      sinceSeq: args.sinceSeq,
      terminalId: args.terminalId,
    });
    if (args.handoffOwnerToken !== undefined) {
      this.handoffOwnerTokensByAttachId.set(attachId, args.handoffOwnerToken);
    }
    const sent = this.transport.send(
      {
        v: V,
        type: "browser.attach",
        attachId,
        terminalId: args.terminalId,
        daemonSessionId: args.daemonSessionId,
        outputAcks: args.outputAcks,
        sinceSeq: args.sinceSeq,
        request: args.request,
      },
      { handle: args.socket },
    );
    if (!sent) {
      this.pending.delete(attachId);
      this.handoffOwnerTokensByAttachId.delete(attachId);
      return null;
    }
    return attachId;
  }

  routeTerminal(args: {
    daemonSessionId: string;
    mode: TerminalDataPlaneRouteMode;
    terminalId: string;
  }): void {
    this.transport.send({
      v: V,
      type: "terminal.route",
      terminalId: args.terminalId,
      daemonSessionId: args.daemonSessionId,
      mode: args.mode,
    });
  }

  unrouteTerminal(terminalId: string): void {
    this.relayedSeqByTerminalId.delete(terminalId);
    this.overloadedTerminalIds.delete(terminalId);
    this.transport.send({ v: V, type: "terminal.unroute", terminalId });
  }

  hasAttachInFlight(terminalId: string): boolean {
    if (this.hasBrowsers(terminalId)) {
      return true;
    }
    for (const pending of this.pending.values()) {
      if (pending.terminalId === terminalId) {
        return true;
      }
    }
    return false;
  }

  hasBrowsers(terminalId: string): boolean {
    return (this.attachIdsByTerminalId.get(terminalId)?.size ?? 0) > 0;
  }

  relayDaemonOutput(terminalId: string, chunk: TerminalOutputChunk): void {
    if (!this.hasBrowsers(terminalId)) {
      return;
    }
    if (this.overloadedTerminalIds.has(terminalId)) {
      return;
    }
    const bytes = chunk.dataBase64.length;
    if (
      this.transport.pendingIpcBytes + bytes >
      TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES
    ) {
      this.overloadedTerminalIds.add(terminalId);
      this.transport.send({ v: V, type: "terminal.resync", terminalId });
      return;
    }
    this.transport.send(
      { v: V, type: "terminal.output", terminalId, chunk },
      { bytes },
    );
  }

  closeTerminalBrowsers(
    terminalId: string,
    code: number,
    reason: string,
  ): void {
    this.transport.send({
      v: V,
      type: "browser.close",
      target: { kind: "terminal", terminalId },
      code,
      reason,
    });
  }

  handleChildMessage(message: TerminalDataPlaneChildMessage): void {
    switch (message.type) {
      case "browser.attached":
        this.handleAttached(message.attachId);
        return;
      case "browser.rejected":
        this.pending.delete(message.attachId);
        return;
      case "browser.detached":
        this.handleDetached(message.attachId);
        return;
      case "browser.control":
        this.withSocket(message.attachId, (socket) =>
          this.lifecycle.handleMessage({
            message: message.message,
            socket,
            terminalId: socket.terminalId,
          }),
        );
        return;
      case "browser.resync":
        this.handleResync(
          message.attachId,
          message.terminalId,
          message.fromSeq,
        );
        return;
      case "terminal.ack":
        this.withSocket(message.attachId, (socket) =>
          this.lifecycle.handleMessage({
            message: { type: "ack", nextSeq: message.nextSeq },
            socket,
            terminalId: socket.terminalId,
          }),
        );
        return;
      case "terminal.visibility":
        this.withSocket(message.attachId, (socket) =>
          this.lifecycle.handleMessage({
            message: { type: "visibility", visible: message.visible },
            socket,
            terminalId: socket.terminalId,
          }),
        );
        return;
      case "terminal.input":
        this.handleInput(
          message.attachId,
          message.terminalId,
          message.dataBase64,
        );
        return;
      case "terminal.input-activity":
        this.lifecycle.recordInputActivity(message.terminalId);
        return;
      case "ready":
      case "daemon.attached":
      case "daemon.detached":
      case "stats":
        return;
    }
  }

  handleChildDown(): void {
    const sockets = [...this.socketsByAttachId.values()];
    this.pending.clear();
    this.handoffOwnerTokensByAttachId.clear();
    this.socketsByAttachId.clear();
    this.attachIdsByTerminalId.clear();
    this.relayedSeqByTerminalId.clear();
    this.overloadedTerminalIds.clear();
    for (const socket of sockets) {
      socket.markClosed();
      this.lifecycle.detach({ socket, terminalId: socket.terminalId });
    }
  }

  replay(
    socket: ChildTerminalSocket,
    frame: ChildTerminalReplayFrame,
    trailing: ChildTerminalBroadcastMessage[],
  ): void {
    const bytes = frame.chunks.reduce(
      (total, chunk) => total + chunk.dataBase64.length,
      0,
    );
    this.transport.send(
      {
        v: V,
        type: "browser.replay",
        attachId: socket.attachId,
        terminalId: socket.terminalId,
        session: frame.session,
        replayStartSeq: frame.replayStartSeq,
        chunks: frame.chunks,
        nextSeq: frame.nextSeq,
      },
      { bytes },
    );
    for (const message of trailing) {
      this.transport.send(
        { v: V, type: "browser.send", terminalId: socket.terminalId, message },
        { bytes: 0 },
      );
    }
  }

  reply(attachId: string, message: ChildTerminalReplyMessage): void {
    this.transport.send(
      { v: V, type: "browser.reply", attachId, message },
      { bytes: 0 },
    );
  }

  broadcast(
    terminalId: string,
    message: ChildTerminalBroadcastMessage,
    bytes: number,
  ): void {
    if (message.type === "exited") {
      this.onTerminalExited(terminalId);
    }
    const key = `${terminalId}\u0000${JSON.stringify(message)}`;
    if (this.lastBroadcastKey === key) {
      return;
    }
    this.lastBroadcastKey = key;
    queueMicrotask(() => {
      if (this.lastBroadcastKey === key) {
        this.lastBroadcastKey = null;
      }
    });
    this.transport.send(
      { v: V, type: "browser.send", terminalId, message },
      { bytes },
    );
  }

  relayOutput(terminalId: string, chunk: TerminalOutputChunk): void {
    const sanitized = this.lifecycle.stripHolderMarkersFromDataPlaneOutput(
      terminalId,
      chunk,
    );
    const relayed = this.relayedSeqByTerminalId.get(terminalId) ?? -1;
    if (sanitized.seq <= relayed) {
      return;
    }
    this.relayedSeqByTerminalId.set(terminalId, sanitized.seq);
    this.relayDaemonOutput(terminalId, sanitized);
  }

  close(attachId: string, code: number, reason: string): void {
    this.transport.send({
      v: V,
      type: "browser.close",
      target: { kind: "attach", attachId },
      code,
      reason,
    });
  }

  private handleAttached(attachId: string): void {
    const pending = this.pending.get(attachId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(attachId);
    const socket = new ChildTerminalSocket(
      attachId,
      pending.terminalId,
      this,
      pending.outputAcks,
      pending.resizeAcks,
    );
    this.socketsByAttachId.set(attachId, socket);
    const ids = this.attachIdsByTerminalId.get(pending.terminalId) ?? new Set();
    ids.add(attachId);
    this.attachIdsByTerminalId.set(pending.terminalId, ids);
    this.lifecycle.attach({
      handoffOwnerToken: this.handoffOwnerTokensByAttachId.get(attachId),
      outputAcks: pending.outputAcks,
      resizeAcks: pending.resizeAcks,
      sinceSeq: pending.sinceSeq,
      socket,
      terminalId: pending.terminalId,
    });
  }

  private handleDetached(attachId: string): void {
    const socket = this.socketsByAttachId.get(attachId);
    this.pending.delete(attachId);
    if (socket === undefined) {
      return;
    }
    this.forget(socket);
    this.handoffOwnerTokensByAttachId.delete(attachId);
    socket.markClosed();
    this.lifecycle.detach({ socket, terminalId: socket.terminalId });
  }

  private handleResync(
    attachId: string,
    terminalId: string,
    fromSeq: number,
  ): void {
    const socket = this.socketsByAttachId.get(attachId);
    if (socket === undefined || socket.terminalId !== terminalId) {
      return;
    }
    socket.markClosed();
    this.lifecycle.detach({ socket, terminalId });
    const fresh = new ChildTerminalSocket(
      attachId,
      terminalId,
      this,
      socket.outputAcks,
      socket.resizeAcks,
    );
    this.socketsByAttachId.set(attachId, fresh);
    this.lifecycle.attach({
      handoffOwnerToken: this.handoffOwnerTokensByAttachId.get(attachId),
      outputAcks: fresh.outputAcks,
      resizeAcks: fresh.resizeAcks,
      sinceSeq: fromSeq,
      socket: fresh,
      terminalId,
    });
  }

  private handleInput(
    attachId: string,
    terminalId: string,
    dataBase64: string,
  ): void {
    this.withSocket(attachId, (socket) => {
      if (socket.terminalId !== terminalId) {
        return;
      }
      this.lifecycle.handleMessage({
        message: { type: "input", dataBase64 },
        socket,
        terminalId,
      });
    });
  }

  private withSocket(
    attachId: string,
    run: (socket: ChildTerminalSocket) => void,
  ): void {
    const socket = this.socketsByAttachId.get(attachId);
    if (socket === undefined || socket.isClosed) {
      return;
    }
    run(socket);
  }

  private forget(socket: ChildTerminalSocket): void {
    this.socketsByAttachId.delete(socket.attachId);
    const ids = this.attachIdsByTerminalId.get(socket.terminalId);
    ids?.delete(socket.attachId);
    if (ids !== undefined && ids.size === 0) {
      this.attachIdsByTerminalId.delete(socket.terminalId);
      this.relayedSeqByTerminalId.delete(socket.terminalId);
      this.overloadedTerminalIds.delete(socket.terminalId);
    }
  }
}
