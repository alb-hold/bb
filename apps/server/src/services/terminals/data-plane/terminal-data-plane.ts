import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { BrowserRequestGuardDeps } from "../../../browser-request-guard.js";
import { handleTerminalDataSocketUpgrade } from "../../../ws/terminal-data-socket-upgrade.js";
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
  DaemonDataPlaneCapabilities,
  type DaemonCapabilityLogger,
  type DaemonCapabilityRpcPort,
} from "./daemon-capability.js";
import {
  DaemonDataSockets,
  type DaemonSessionChange,
} from "./daemon-data-sockets.js";
import {
  TerminalDataPlaneRouter,
  type DataPlaneLifecyclePort,
} from "./data-plane-router.js";
import { TerminalDataTicketStore } from "./terminal-data-ticket-store.js";

export interface TerminalDataPlaneDaemonPort {
  currentSessionIdForHost(hostId: string): string | null;
  request: DaemonCapabilityRpcPort["request"];
  setSessionDirectOutput(args: {
    daemonSessionId: string;
    enabled: boolean;
  }): void;
  subscribe(listener: (change: DaemonSessionChange) => void): () => void;
  verify(authorizationHeader: string | undefined): Promise<{ hostId: string }>;
}

export interface TerminalDataPlaneOptions {
  daemons: TerminalDataPlaneDaemonPort;
  dataSocketRetryDelaysMs?: readonly number[];
  guard: BrowserRequestGuardDeps;
  lifecycle: DataPlaneLifecyclePort;
  logger: DataPlaneSupervisorLogger & DaemonCapabilityLogger;
  resolveTerminal(terminalId: string): TerminalUpgradeTarget | null;
  server: Server;
  spawn: DataPlaneSpawn;
}

export interface TerminalDataPlane {
  readonly attachedSocketCount: number;
  readonly state: DataPlaneState;
  isSessionAttached(daemonSessionId: string): boolean;
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
    onDown: () => {
      router.handleChildDown();
      dataSockets.handleChildDown();
    },
    onMessage: (message) => {
      router.handleChildMessage(message);
      dataSockets.handleChildMessage(message);
    },
    onReady: () => dataSockets.handleChildReady(),
    spawn: options.spawn,
  });
  const router = new TerminalDataPlaneRouter(supervisor, options.lifecycle);
  const tickets = new TerminalDataTicketStore();
  const rpc = { request: options.daemons.request };
  const dataSockets = new DaemonDataSockets({
    capabilities: new DaemonDataPlaneCapabilities({
      logger: options.logger,
      newRequestId: randomUUID,
      rpc,
    }),
    logger: options.logger,
    newRequestId: randomUUID,
    ...(options.dataSocketRetryDelaysMs === undefined
      ? {}
      : { retryDelaysMs: options.dataSocketRetryDelaysMs }),
    rpc,
    setSessionDirectOutput: options.daemons.setSessionDirectOutput,
    tickets,
    transport: supervisor,
  });
  installTerminalUpgradeHandoff(options.server, {
    attach: (args) =>
      dataSockets.routeTerminal(args) ? router.attachBrowser(args) : null,
    guard: options.guard,
    handleDataSocketUpgrade: (request, socket, head) =>
      handleTerminalDataSocketUpgrade(
        {
          attach: (args) => dataSockets.attachSocket(args),
          currentSessionIdForHost: options.daemons.currentSessionIdForHost,
          guard: options.guard,
          redeemTicket: (ticket) => tickets.redeem(ticket),
          verifyDaemon: options.daemons.verify,
        },
        request,
        socket,
        head,
      ),
    isAvailable: () => router.isAvailable,
    resolveTerminal: (terminalId) => {
      const target = options.resolveTerminal(terminalId);
      return target !== null && dataSockets.isAttached(target.daemonSessionId)
        ? target
        : null;
    },
  });
  supervisor.start();
  const unsubscribe = options.daemons.subscribe((change) =>
    dataSockets.handleSessionChange(change),
  );
  return {
    get attachedSocketCount() {
      return router.attachedSocketCount;
    },
    get state() {
      return supervisor.state;
    },
    isSessionAttached: (daemonSessionId) =>
      dataSockets.isAttached(daemonSessionId),
    stop: () => {
      unsubscribe();
      dataSockets.stop();
      supervisor.stop();
    },
  };
}
