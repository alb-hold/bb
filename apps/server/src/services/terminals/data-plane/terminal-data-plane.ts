import { fork } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { BrowserRequestGuardDeps } from "../../../browser-request-guard.js";
import {
  installTerminalUpgradeHandoff,
  type TerminalUpgradeTarget,
} from "../../../ws/terminal-upgrade-handoff.js";
import {
  DataPlaneChildSupervisor,
  type DataPlaneSpawn,
  type DataPlaneState,
  type DataPlaneSupervisorLogger,
} from "./child-supervisor.js";
import {
  TerminalDataPlaneRouter,
  type DataPlaneLifecyclePort,
} from "./data-plane-router.js";

export interface TerminalDataPlaneOptions {
  guard: BrowserRequestGuardDeps;
  lifecycle: DataPlaneLifecyclePort;
  logger: DataPlaneSupervisorLogger;
  resolveTerminal(terminalId: string): TerminalUpgradeTarget | null;
  server: Server;
  spawn: DataPlaneSpawn;
}

export interface TerminalDataPlane {
  readonly attachedSocketCount: number;
  readonly state: DataPlaneState;
  stop(): void;
}

export function createTerminalDataPlaneSpawn(): DataPlaneSpawn {
  const runningFromSource = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(
    runningFromSource
      ? new URL("../../../terminal-data-plane/child-main.ts", import.meta.url)
      : new URL("./terminal-data-plane-child.js", import.meta.url),
  );
  return () =>
    fork(entry, [], {
      execArgv: process.execArgv,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
}

export function startTerminalDataPlane(
  options: TerminalDataPlaneOptions,
): TerminalDataPlane {
  const supervisor: DataPlaneChildSupervisor = new DataPlaneChildSupervisor({
    logger: options.logger,
    onDown: () => router.handleChildDown(),
    onMessage: (message) => router.handleChildMessage(message),
    onReady: () => undefined,
    spawn: options.spawn,
  });
  const router = new TerminalDataPlaneRouter(supervisor, options.lifecycle);
  installTerminalUpgradeHandoff(options.server, {
    attach: (args) => router.attachBrowser(args),
    guard: options.guard,
    isAvailable: () => router.isAvailable,
    resolveTerminal: options.resolveTerminal,
  });
  supervisor.start();
  return {
    get attachedSocketCount() {
      return router.attachedSocketCount;
    },
    get state() {
      return supervisor.state;
    },
    stop: () => supervisor.stop(),
  };
}
