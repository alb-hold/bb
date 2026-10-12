import type { Socket } from "node:net";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  parseTerminalDataPlaneChildToMainMessage,
  TerminalDataPlaneIpcError,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "../../../terminal-data-plane/ipc-contract.js";

export const CHILD_RESPAWN_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
export const CHILD_STABLE_READY_MS = 60_000;
export const CHILD_FAILURE_WINDOW_MS = 30_000;
export const CHILD_FAILURES_BEFORE_FALLBACK = 5;
export const CHILD_FALLBACK_COOLDOWN_MS = 60_000;

export interface DataPlaneChildProcess {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  send(
    message: TerminalDataPlaneMainMessage,
    handle: Socket | undefined,
    callback: (error: Error | null) => void,
  ): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit" | "disconnect", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type DataPlaneSpawn = () => DataPlaneChildProcess;

export type DataPlaneState = "starting" | "ready" | "down" | "fallback";

export interface DataPlaneSupervisorLogger {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface DataPlaneSupervisorOptions {
  logger: DataPlaneSupervisorLogger;
  now?: () => number;
  onDown: () => void;
  onMessage: (message: TerminalDataPlaneChildMessage) => void;
  onReady: () => void;
  spawn: DataPlaneSpawn;
}

export class DataPlaneChildSupervisor {
  private child: DataPlaneChildProcess | null = null;
  private currentState: DataPlaneState = "down";
  private failureTimes: number[] = [];
  private consecutiveFailures = 0;
  private readySince: number | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pendingBytes = 0;
  private lastFallbackLogAt = 0;

  constructor(private readonly options: DataPlaneSupervisorOptions) {}

  get state(): DataPlaneState {
    return this.currentState;
  }

  get pendingIpcBytes(): number {
    return this.pendingBytes;
  }

  get isReady(): boolean {
    return this.currentState === "ready";
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.respawnTimer !== null) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.currentState = "down";
    if (child !== null) {
      try {
        child.send(
          { v: TERMINAL_DATA_PLANE_IPC_VERSION, type: "shutdown" },
          undefined,
          () => undefined,
        );
      } catch {}
      child.kill("SIGTERM");
    }
  }

  send(
    message: TerminalDataPlaneMainMessage,
    options: { bytes?: number; handle?: Socket } = {},
  ): boolean {
    const child = this.child;
    if (child === null || !child.connected || this.currentState !== "ready") {
      return false;
    }
    const bytes = options.bytes ?? 0;
    this.pendingBytes += bytes;
    try {
      child.send(message, options.handle, (error) => {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
        if (error !== null) {
          this.options.logger.warn(
            { err: error, messageType: message.type },
            "Terminal data plane IPC send failed",
          );
        }
      });
      return true;
    } catch (error) {
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      this.options.logger.warn(
        { err: error, messageType: message.type },
        "Terminal data plane IPC send threw",
      );
      return false;
    }
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    this.currentState = "starting";
    let child: DataPlaneChildProcess;
    try {
      child = this.options.spawn();
    } catch (error) {
      this.options.logger.error(
        { err: error },
        "Terminal data plane child failed to spawn",
      );
      this.recordFailure();
      return;
    }
    this.child = child;
    child.on("message", (raw) => this.handleRaw(child, raw));
    child.on("error", (error) => {
      this.options.logger.warn(
        { err: error },
        "Terminal data plane child errored",
      );
    });
    child.on("exit", () => this.handleGone(child));
    child.on("disconnect", () => this.handleGone(child));
  }

  private handleRaw(child: DataPlaneChildProcess, raw: unknown): void {
    if (child !== this.child) {
      return;
    }
    let message: TerminalDataPlaneChildMessage;
    try {
      message = parseTerminalDataPlaneChildToMainMessage(raw);
    } catch (error) {
      if (!(error instanceof TerminalDataPlaneIpcError)) {
        throw error;
      }
      this.options.logger.warn(
        { err: error, rejection: error.rejection },
        "Terminal data plane child sent an invalid message",
      );
      return;
    }
    if (message.type === "ready") {
      this.currentState = "ready";
      this.readySince = this.now();
      this.options.onReady();
      return;
    }
    this.options.onMessage(message);
  }

  private handleGone(child: DataPlaneChildProcess): void {
    if (child !== this.child) {
      return;
    }
    this.child = null;
    this.pendingBytes = 0;
    if (this.stopped) {
      this.currentState = "down";
      return;
    }
    const stableFor =
      this.readySince === null ? 0 : this.now() - this.readySince;
    this.readySince = null;
    if (stableFor >= CHILD_STABLE_READY_MS) {
      this.consecutiveFailures = 0;
      this.failureTimes = [];
    }
    this.options.onDown();
    this.recordFailure();
  }

  private recordFailure(): void {
    const now = this.now();
    this.failureTimes = this.failureTimes.filter(
      (at) => now - at < CHILD_FAILURE_WINDOW_MS,
    );
    this.failureTimes.push(now);
    const delayIndex = Math.min(
      this.consecutiveFailures,
      CHILD_RESPAWN_DELAYS_MS.length - 1,
    );
    this.consecutiveFailures += 1;
    let delay = CHILD_RESPAWN_DELAYS_MS[delayIndex] ?? 5_000;
    if (this.failureTimes.length >= CHILD_FAILURES_BEFORE_FALLBACK) {
      this.currentState = "fallback";
      delay = CHILD_FALLBACK_COOLDOWN_MS;
      if (now - this.lastFallbackLogAt >= 60_000) {
        this.lastFallbackLogAt = now;
        this.options.logger.error(
          { failures: this.failureTimes.length },
          "Terminal data plane child keeps crashing; terminals use the main relay",
        );
      }
    } else {
      this.currentState = "down";
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.spawnChild();
    }, delay);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
