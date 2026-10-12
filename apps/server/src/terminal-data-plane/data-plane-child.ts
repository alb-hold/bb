import { Socket } from "node:net";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import {
  terminalClientMessageSchema,
  terminalOutputChunkSchema,
  type TerminalOutputChunk,
  type TerminalServerMessage,
} from "@bb/server-contract";
import { z } from "zod";
import {
  TerminalOutputFlowControl,
  type TerminalOutputFlowDaemonMessage,
} from "../services/terminals/terminal-output-flow-control.js";
import { parseSocketMessage } from "../ws/decode-payload.js";
import {
  TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
  TERMINAL_DATA_PLANE_INPUT_ACTIVITY_INTERVAL_MS,
  TERMINAL_DATA_PLANE_INPUT_COALESCE_MS,
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
  TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES,
  TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
  TERMINAL_DATA_PLANE_STATS_INTERVAL_MS,
  TerminalDataPlaneIpcError,
  parseTerminalDataPlaneMainToChildMessage,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneHandoffRequest,
  type TerminalDataPlaneMainMessage,
  type TerminalDataPlaneRouteMode,
} from "./ipc-contract.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

export interface TerminalDataPlaneSocket {
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  send(data: string): void;
  terminate(): void;
}

export type TerminalDataPlaneSocketUpgrade = (
  request: TerminalDataPlaneHandoffRequest,
  socket: Socket,
) => Promise<TerminalDataPlaneSocket>;

export interface TerminalDataPlaneChildOptions {
  exit: () => void;
  now?: () => number;
  rssBytes: () => number;
  sendToMain: (
    message: TerminalDataPlaneChildMessage,
    onSent: () => void,
  ) => void;
  upgrade: TerminalDataPlaneSocketUpgrade;
}

export const terminalDataPlaneDaemonFrameSchema = z
  .object({
    type: z.literal("terminal.output"),
    terminalId: z.string().min(1),
    chunk: terminalOutputChunkSchema,
  })
  .strict();

type MainMessage<Type extends TerminalDataPlaneMainMessage["type"]> = Extract<
  TerminalDataPlaneMainMessage,
  { type: Type }
>;

interface BrowserAttach {
  readonly attachId: string;
  readonly daemonSessionId: string;
  readonly outputAcks: boolean;
  readonly terminalId: string;
  attachedFrameSent: boolean;
  buffered: TerminalOutputChunk[];
  bufferedBytes: number;
  closed: boolean;
  flowClient: boolean;
  lastAckedSeq: number | null;
  live: boolean;
  nextSeq: number;
  queuedControl: string[];
  resyncRequested: boolean;
  socket: TerminalDataPlaneSocket | null;
  visible: boolean;
}

interface TerminalRoute {
  daemonSessionId: string;
  mode: TerminalDataPlaneRouteMode;
}

interface InputWindow {
  bytes: number;
  parts: Buffer[];
  timer: ReturnType<typeof setTimeout>;
}

function destroyHandle(handle: unknown): void {
  if (handle instanceof Socket) {
    handle.destroy();
  }
}

export class TerminalDataPlaneChild {
  private readonly attaches = new Map<string, BrowserAttach>();
  private readonly attachesByTerminalId = new Map<string, Set<BrowserAttach>>();
  private readonly daemonSockets = new Map<string, TerminalDataPlaneSocket>();
  private readonly routes = new Map<string, TerminalRoute>();
  private readonly inputWindows = new Map<string, InputWindow>();
  private readonly lastInputActivityAt = new Map<string, number>();
  private readonly flow: TerminalOutputFlowControl;
  private readonly now: () => number;
  private droppedMisroutedFrames = 0;
  private pendingIpcBytes = 0;
  private rejectedMainMessages = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: TerminalDataPlaneChildOptions) {
    this.now = options.now ?? Date.now;
    this.flow = new TerminalOutputFlowControl({
      now: this.now,
      sendDaemonMessage: (daemonSessionId, message) =>
        this.sendDaemonMessage(daemonSessionId, message),
    });
  }

  get browserSocketCount(): number {
    let count = 0;
    for (const attach of this.attaches.values()) {
      if (attach.socket !== null) {
        count += 1;
      }
    }
    return count;
  }

  get daemonSocketCount(): number {
    return this.daemonSockets.size;
  }

  get rejectedMainMessageCount(): number {
    return this.rejectedMainMessages;
  }

  start(): void {
    this.send({ v: V, type: "ready", pid: process.pid });
    this.statsTimer = setInterval(
      () => this.sendStats(),
      TERMINAL_DATA_PLANE_STATS_INTERVAL_MS,
    );
    this.statsTimer.unref();
  }

  shutdown(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const window of this.inputWindows.values()) {
      clearTimeout(window.timer);
    }
    this.inputWindows.clear();
    for (const terminalId of this.attachesByTerminalId.keys()) {
      this.flow.forgetTerminal(terminalId);
    }
    for (const attach of this.attaches.values()) {
      attach.closed = true;
      attach.socket?.terminate();
    }
    this.attaches.clear();
    this.attachesByTerminalId.clear();
    for (const socket of this.daemonSockets.values()) {
      socket.terminate();
    }
    this.daemonSockets.clear();
    this.routes.clear();
    this.options.exit();
  }

  handleMainMessage(raw: unknown, handle: unknown): void {
    if (this.stopped) {
      destroyHandle(handle);
      return;
    }
    let message: TerminalDataPlaneMainMessage;
    try {
      message = parseTerminalDataPlaneMainToChildMessage(raw);
    } catch (error) {
      destroyHandle(handle);
      if (!(error instanceof TerminalDataPlaneIpcError)) {
        throw error;
      }
      this.rejectedMainMessages += 1;
      return;
    }
    switch (message.type) {
      case "browser.attach":
        this.attachBrowser(message, handle);
        return;
      case "daemon.attach":
        this.attachDaemon(message, handle);
        return;
      default:
        destroyHandle(handle);
    }
    switch (message.type) {
      case "browser.replay":
        this.applyReplay(message);
        return;
      case "browser.send":
        this.sendControl(message.terminalId, message.message);
        return;
      case "browser.close":
        this.closeTarget(message);
        return;
      case "daemon.detach":
        this.detachDaemon(message.daemonSessionId);
        return;
      case "terminal.route":
        this.routes.set(message.terminalId, {
          daemonSessionId: message.daemonSessionId,
          mode: message.mode,
        });
        this.closeAttachesBoundElsewhere(message.terminalId);
        this.syncTerminalFlowClients(message.terminalId);
        return;
      case "terminal.unroute":
        this.unrouteTerminal(message.terminalId);
        return;
      case "terminal.output":
        this.deliverOutput(message.terminalId, message.chunk, null);
        return;
      case "terminal.resync":
        this.closeTerminalSockets(
          message.terminalId,
          TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
          "terminal-resync",
        );
        return;
      case "shutdown":
        this.shutdown();
        return;
    }
  }

  private attachBrowser(
    message: MainMessage<"browser.attach">,
    handle: unknown,
  ): void {
    if (!(handle instanceof Socket)) {
      this.rejectBrowser(
        message.attachId,
        "missing_socket",
        "browser.attach arrived without a socket",
      );
      return;
    }
    if (this.attaches.has(message.attachId)) {
      handle.destroy();
      return;
    }
    const attach: BrowserAttach = {
      attachId: message.attachId,
      daemonSessionId: message.daemonSessionId,
      outputAcks: message.outputAcks,
      terminalId: message.terminalId,
      attachedFrameSent: false,
      buffered: [],
      bufferedBytes: 0,
      closed: false,
      flowClient: false,
      lastAckedSeq: null,
      live: false,
      nextSeq: message.sinceSeq ?? 0,
      queuedControl: [],
      resyncRequested: false,
      socket: null,
      visible: true,
    };
    this.attaches.set(attach.attachId, attach);
    const siblings = this.attachesByTerminalId.get(attach.terminalId);
    if (siblings === undefined) {
      this.attachesByTerminalId.set(attach.terminalId, new Set([attach]));
    } else {
      siblings.add(attach);
    }
    this.options.upgrade(message.request, handle).then(
      (socket) => {
        if (attach.closed) {
          socket.terminate();
          return;
        }
        attach.socket = socket;
        socket.on("message", (data) => this.handleBrowserFrame(attach, data));
        socket.on("close", () => this.handleBrowserClosed(attach));
        socket.on("error", () => socket.terminate());
        this.send({ v: V, type: "browser.attached", attachId: attach.attachId });
      },
      (error: unknown) => {
        handle.destroy();
        if (attach.closed) {
          return;
        }
        attach.closed = true;
        this.forgetAttach(attach);
        this.rejectBrowser(
          attach.attachId,
          "upgrade_failed",
          error instanceof Error && error.message.length > 0
            ? error.message
            : "WebSocket upgrade failed",
        );
      },
    );
  }

  private rejectBrowser(attachId: string, code: string, message: string): void {
    this.send({ v: V, type: "browser.rejected", attachId, code, message });
  }

  private handleBrowserFrame(attach: BrowserAttach, data: unknown): void {
    if (attach.closed) {
      return;
    }
    const message = parseSocketMessage(
      {
        close: (code, reason) =>
          this.closeAttach(attach, code ?? 1008, reason ?? "invalid-message"),
      },
      data,
      terminalClientMessageSchema,
    );
    if (message === null) {
      return;
    }
    switch (message.type) {
      case "ping":
        this.write(attach, JSON.stringify({ type: "pong" }));
        return;
      case "input":
        this.forwardInput(attach, message.dataBase64);
        return;
      case "resize":
        this.send({
          v: V,
          type: "browser.control",
          attachId: attach.attachId,
          terminalId: attach.terminalId,
          message,
        });
        return;
      case "ack":
        this.acknowledge(attach, message.nextSeq);
        return;
      case "visibility":
        attach.visible = message.visible;
        if (attach.flowClient) {
          this.flow.setVisible(attach.terminalId, attach, message.visible);
        }
        this.send({
          v: V,
          type: "terminal.visibility",
          attachId: attach.attachId,
          terminalId: attach.terminalId,
          visible: message.visible,
        });
        return;
    }
  }

  private acknowledge(attach: BrowserAttach, nextSeq: number): void {
    if (nextSeq > 0 && nextSeq - 1 > (attach.lastAckedSeq ?? -1)) {
      attach.lastAckedSeq = nextSeq - 1;
    }
    if (attach.flowClient) {
      this.flow.acknowledge(attach.terminalId, attach, nextSeq);
      return;
    }
    this.send({
      v: V,
      type: "terminal.ack",
      attachId: attach.attachId,
      terminalId: attach.terminalId,
      nextSeq,
    });
  }

  private handleBrowserClosed(attach: BrowserAttach): void {
    if (attach.closed) {
      return;
    }
    attach.closed = true;
    this.forgetAttach(attach);
    this.send({
      v: V,
      type: "browser.detached",
      attachId: attach.attachId,
      terminalId: attach.terminalId,
      lastAckedSeq: attach.lastAckedSeq,
    });
  }

  private forgetAttach(attach: BrowserAttach): void {
    this.attaches.delete(attach.attachId);
    attach.buffered = [];
    attach.bufferedBytes = 0;
    attach.queuedControl = [];
    if (attach.flowClient) {
      attach.flowClient = false;
      this.flow.removeClient(attach.terminalId, attach);
    }
    const siblings = this.attachesByTerminalId.get(attach.terminalId);
    if (siblings === undefined) {
      return;
    }
    siblings.delete(attach);
    if (siblings.size === 0) {
      this.attachesByTerminalId.delete(attach.terminalId);
      this.lastInputActivityAt.delete(attach.terminalId);
    }
  }

  private closeAttach(attach: BrowserAttach, code: number, reason: string): void {
    if (attach.closed) {
      return;
    }
    const socket = attach.socket;
    if (socket === null) {
      attach.closed = true;
      this.forgetAttach(attach);
      this.rejectBrowser(
        attach.attachId,
        "closed_before_attach",
        "The socket was closed before the WebSocket upgrade completed",
      );
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
    this.handleBrowserClosed(attach);
  }

  private closeTarget(message: MainMessage<"browser.close">): void {
    if (message.target.kind === "attach") {
      const attach = this.attaches.get(message.target.attachId);
      if (attach !== undefined) {
        this.closeAttach(attach, message.code, message.reason);
      }
      return;
    }
    this.closeTerminalSockets(
      message.target.terminalId,
      message.code,
      message.reason,
    );
  }

  private closeTerminalSockets(
    terminalId: string,
    code: number,
    reason: string,
  ): void {
    for (const attach of [...(this.attachesByTerminalId.get(terminalId) ?? [])]) {
      this.closeAttach(attach, code, reason);
    }
  }

  private write(attach: BrowserAttach, frame: string): void {
    const socket = attach.socket;
    if (attach.closed || socket === null) {
      return;
    }
    try {
      socket.send(frame);
    } catch {
      socket.terminate();
      this.handleBrowserClosed(attach);
      return;
    }
    if (socket.bufferedAmount > TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES) {
      this.closeAttach(
        attach,
        TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
        "browser-backlog",
      );
    }
  }

  private sendControl(
    terminalId: string,
    message: Extract<
      TerminalServerMessage,
      { type: "session-updated" | "exited" | "error" }
    >,
  ): void {
    const frame = JSON.stringify(message);
    for (const attach of [...(this.attachesByTerminalId.get(terminalId) ?? [])]) {
      if (attach.attachedFrameSent) {
        this.write(attach, frame);
      } else {
        attach.queuedControl.push(frame);
      }
    }
  }

  private applyReplay(message: MainMessage<"browser.replay">): void {
    const attach = this.attaches.get(message.attachId);
    if (
      attach === undefined ||
      attach.closed ||
      attach.socket === null ||
      attach.terminalId !== message.terminalId
    ) {
      return;
    }
    if (this.isBoundElsewhere(attach)) {
      this.closeAttach(
        attach,
        TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
        "daemon-session-changed",
      );
      return;
    }
    if (!attach.attachedFrameSent) {
      attach.attachedFrameSent = true;
      this.write(
        attach,
        JSON.stringify({
          type: "attached",
          session: message.session,
          replayStartSeq: message.replayStartSeq,
          nextSeq: message.nextSeq,
        }),
      );
      for (const chunk of message.chunks) {
        this.write(attach, JSON.stringify({ type: "output", chunk }));
      }
      attach.nextSeq = message.nextSeq;
      const queued = attach.queuedControl;
      attach.queuedControl = [];
      for (const frame of queued) {
        this.write(attach, frame);
      }
    } else {
      if (message.replayStartSeq > attach.nextSeq) {
        this.closeAttach(
          attach,
          TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
          "replay-gap",
        );
        return;
      }
      for (const chunk of message.chunks) {
        if (chunk.seq === attach.nextSeq) {
          this.write(attach, JSON.stringify({ type: "output", chunk }));
          attach.nextSeq = chunk.seq + 1;
        }
      }
      if (attach.nextSeq < message.nextSeq) {
        this.closeAttach(
          attach,
          TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
          "replay-gap",
        );
        return;
      }
    }
    if (attach.closed) {
      return;
    }
    attach.resyncRequested = false;
    const buffered = attach.buffered;
    attach.buffered = [];
    attach.bufferedBytes = 0;
    attach.live = true;
    this.syncFlowClient(attach);
    for (const chunk of buffered) {
      this.deliver(attach, chunk, null);
    }
  }

  private deliverOutput(
    terminalId: string,
    chunk: TerminalOutputChunk,
    dataSocketSessionId: string | null,
  ): void {
    const attaches = this.attachesByTerminalId.get(terminalId);
    if (attaches === undefined) {
      return;
    }
    const frame = JSON.stringify({ type: "output", chunk });
    for (const attach of [...attaches]) {
      if (
        dataSocketSessionId === null ||
        attach.daemonSessionId === dataSocketSessionId
      ) {
        this.deliver(attach, chunk, frame);
      }
    }
  }

  private isBoundElsewhere(attach: BrowserAttach): boolean {
    const route = this.routes.get(attach.terminalId);
    return (
      route !== undefined &&
      route.mode === "data-socket" &&
      route.daemonSessionId !== attach.daemonSessionId
    );
  }

  private closeAttachesBoundElsewhere(terminalId: string): void {
    for (const attach of [...(this.attachesByTerminalId.get(terminalId) ?? [])]) {
      if (attach.socket !== null && this.isBoundElsewhere(attach)) {
        this.closeAttach(
          attach,
          TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
          "daemon-session-changed",
        );
      }
    }
  }

  private deliver(
    attach: BrowserAttach,
    chunk: TerminalOutputChunk,
    frame: string | null,
  ): void {
    if (attach.closed) {
      return;
    }
    if (!attach.live) {
      this.buffer(attach, chunk);
      return;
    }
    if (chunk.seq < attach.nextSeq) {
      return;
    }
    if (chunk.seq > attach.nextSeq) {
      attach.live = false;
      this.buffer(attach, chunk);
      if (!attach.closed && !attach.resyncRequested) {
        attach.resyncRequested = true;
        this.send({
          v: V,
          type: "browser.resync",
          attachId: attach.attachId,
          terminalId: attach.terminalId,
          fromSeq: attach.nextSeq,
        });
      }
      return;
    }
    attach.nextSeq = chunk.seq + 1;
    this.write(attach, frame ?? JSON.stringify({ type: "output", chunk }));
  }

  private buffer(attach: BrowserAttach, chunk: TerminalOutputChunk): void {
    const last = attach.buffered.at(-1);
    if (last !== undefined && chunk.seq <= last.seq) {
      return;
    }
    attach.buffered.push(chunk);
    attach.bufferedBytes += chunk.dataBase64.length;
    if (attach.bufferedBytes > TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES) {
      this.closeAttach(
        attach,
        TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
        "replay-buffer-overflow",
      );
    }
  }

  private forwardInput(attach: BrowserAttach, dataBase64: string): void {
    const terminalId = attach.terminalId;
    const now = this.now();
    const lastActivityAt = this.lastInputActivityAt.get(terminalId);
    if (
      lastActivityAt === undefined ||
      now - lastActivityAt >= TERMINAL_DATA_PLANE_INPUT_ACTIVITY_INTERVAL_MS
    ) {
      this.lastInputActivityAt.set(terminalId, now);
      this.send({ v: V, type: "terminal.input-activity", terminalId, at: now });
    }
    const route = this.routes.get(terminalId);
    if (
      route !== undefined &&
      route.mode === "data-socket" &&
      route.daemonSessionId === attach.daemonSessionId
    ) {
      const daemon = this.daemonSockets.get(route.daemonSessionId);
      if (daemon !== undefined) {
        this.writeDaemon(
          route.daemonSessionId,
          daemon,
          JSON.stringify({ type: "terminal.input", terminalId, dataBase64 }),
        );
        return;
      }
    }
    const data = Buffer.from(dataBase64, "base64");
    const window = this.inputWindows.get(terminalId);
    if (window === undefined) {
      this.relayInput(terminalId, data);
      this.inputWindows.set(terminalId, {
        bytes: 0,
        parts: [],
        timer: this.armInputWindow(terminalId),
      });
      return;
    }
    if (window.bytes + data.length > TERMINAL_DATA_MAX_BYTES) {
      this.flushInputWindow(terminalId, window);
    }
    window.parts.push(data);
    window.bytes += data.length;
  }

  private armInputWindow(terminalId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const window = this.inputWindows.get(terminalId);
      if (window === undefined) {
        return;
      }
      if (window.parts.length === 0) {
        this.inputWindows.delete(terminalId);
        return;
      }
      this.flushInputWindow(terminalId, window);
      window.timer = this.armInputWindow(terminalId);
    }, TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);
  }

  private flushInputWindow(terminalId: string, window: InputWindow): void {
    if (window.parts.length === 0) {
      return;
    }
    const data = Buffer.concat(window.parts, window.bytes);
    window.parts = [];
    window.bytes = 0;
    this.relayInput(terminalId, data);
  }

  private relayInput(terminalId: string, data: Buffer): void {
    const dataBase64 = data.toString("base64");
    const bytes = dataBase64.length;
    if (
      this.pendingIpcBytes + bytes >
      TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES
    ) {
      this.closeTerminalSockets(
        terminalId,
        TERMINAL_DATA_PLANE_OVERLOAD_CLOSE_CODE,
        "input-backlog",
      );
      return;
    }
    this.pendingIpcBytes += bytes;
    this.options.sendToMain(
      { v: V, type: "terminal.input", terminalId, dataBase64 },
      () => {
        this.pendingIpcBytes = Math.max(0, this.pendingIpcBytes - bytes);
      },
    );
  }

  private attachDaemon(
    message: MainMessage<"daemon.attach">,
    handle: unknown,
  ): void {
    const daemonSessionId = message.daemonSessionId;
    if (!(handle instanceof Socket)) {
      this.send({ v: V, type: "daemon.detached", daemonSessionId });
      return;
    }
    this.options.upgrade(message.request, handle).then(
      (socket) => {
        if (this.stopped) {
          socket.terminate();
          return;
        }
        const previous = this.daemonSockets.get(daemonSessionId);
        this.daemonSockets.set(daemonSessionId, socket);
        previous?.terminate();
        socket.on("message", (data) =>
          this.handleDaemonFrame(daemonSessionId, socket, data),
        );
        socket.on("close", () => this.handleDaemonClosed(daemonSessionId, socket));
        socket.on("error", () => socket.terminate());
        this.syncSessionFlowClients(daemonSessionId);
        this.send({ v: V, type: "daemon.attached", daemonSessionId });
      },
      () => {
        handle.destroy();
        this.send({ v: V, type: "daemon.detached", daemonSessionId });
      },
    );
  }

  private handleDaemonFrame(
    daemonSessionId: string,
    socket: TerminalDataPlaneSocket,
    data: unknown,
  ): void {
    if (this.daemonSockets.get(daemonSessionId) !== socket) {
      return;
    }
    const message = parseSocketMessage(
      socket,
      data,
      terminalDataPlaneDaemonFrameSchema,
    );
    if (message === null) {
      return;
    }
    const route = this.routes.get(message.terminalId);
    if (
      route === undefined ||
      route.mode !== "data-socket" ||
      route.daemonSessionId !== daemonSessionId
    ) {
      this.droppedMisroutedFrames += 1;
      return;
    }
    this.flow.recordOutput(
      message.terminalId,
      daemonSessionId,
      message.chunk.seq,
    );
    this.deliverOutput(message.terminalId, message.chunk, daemonSessionId);
  }

  private handleDaemonClosed(
    daemonSessionId: string,
    socket: TerminalDataPlaneSocket,
  ): void {
    if (this.daemonSockets.get(daemonSessionId) !== socket) {
      return;
    }
    this.daemonSockets.delete(daemonSessionId);
    this.syncSessionFlowClients(daemonSessionId);
    this.send({ v: V, type: "daemon.detached", daemonSessionId });
  }

  private syncSessionFlowClients(daemonSessionId: string): void {
    for (const [terminalId, route] of this.routes) {
      if (route.daemonSessionId === daemonSessionId) {
        this.syncTerminalFlowClients(terminalId);
      }
    }
  }

  private detachDaemon(daemonSessionId: string): void {
    const socket = this.daemonSockets.get(daemonSessionId);
    this.daemonSockets.delete(daemonSessionId);
    for (const [terminalId, route] of [...this.routes]) {
      if (route.daemonSessionId === daemonSessionId) {
        this.unrouteTerminal(terminalId);
      }
    }
    if (socket !== undefined) {
      try {
        socket.close(1000, "daemon-detached");
      } catch {
        socket.terminate();
      }
    }
  }

  private unrouteTerminal(terminalId: string): void {
    this.routes.delete(terminalId);
    this.syncTerminalFlowClients(terminalId);
    this.flow.forgetTerminal(terminalId);
    const window = this.inputWindows.get(terminalId);
    if (window !== undefined) {
      clearTimeout(window.timer);
      this.flushInputWindow(terminalId, window);
      this.inputWindows.delete(terminalId);
    }
  }

  private syncTerminalFlowClients(terminalId: string): void {
    for (const attach of this.attachesByTerminalId.get(terminalId) ?? []) {
      this.syncFlowClient(attach);
    }
  }

  private syncFlowClient(attach: BrowserAttach): void {
    const route = this.routes.get(attach.terminalId);
    const governs =
      !attach.closed &&
      attach.attachedFrameSent &&
      attach.outputAcks &&
      route !== undefined &&
      route.mode === "data-socket" &&
      this.daemonSockets.has(route.daemonSessionId);
    if (governs === attach.flowClient) {
      return;
    }
    attach.flowClient = governs;
    if (governs) {
      this.flow.addClient(
        attach.terminalId,
        attach,
        attach.nextSeq,
        attach.visible,
      );
    } else {
      this.flow.removeClient(attach.terminalId, attach);
    }
  }

  private sendDaemonMessage(
    daemonSessionId: string,
    message: TerminalOutputFlowDaemonMessage,
  ): void {
    const socket = this.daemonSockets.get(daemonSessionId);
    if (socket !== undefined) {
      this.writeDaemon(daemonSessionId, socket, JSON.stringify(message));
    }
  }

  private writeDaemon(
    daemonSessionId: string,
    socket: TerminalDataPlaneSocket,
    frame: string,
  ): void {
    try {
      socket.send(frame);
    } catch {
      socket.terminate();
      this.handleDaemonClosed(daemonSessionId, socket);
    }
  }

  private sendStats(): void {
    this.send({
      v: V,
      type: "stats",
      rssBytes: this.options.rssBytes(),
      browserSockets: this.browserSocketCount,
      daemonSockets: this.daemonSocketCount,
      droppedMisroutedFrames: this.droppedMisroutedFrames,
    });
  }

  private send(message: TerminalDataPlaneChildMessage): void {
    if (this.stopped) {
      return;
    }
    this.options.sendToMain(message, () => undefined);
  }
}
