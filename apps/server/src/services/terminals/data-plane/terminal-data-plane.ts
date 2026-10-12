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
  type DataPlaneAttachArgs,
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
  logger: DataPlaneSupervisorLogger &
    DaemonCapabilityLogger & {
      info(fields: Record<string, unknown>, message: string): void;
    };
  resolveTerminal(terminalId: string): TerminalUpgradeTarget | null;
  server: Server;
  spawn: DataPlaneSpawn;
}

export interface TerminalDataPlane {
  readonly attachedSocketCount: number;
  readonly state: DataPlaneState;
  isSessionAttached(daemonSessionId: string): boolean;
  isTerminalRouted(terminalId: string): boolean;
  stop(): void;
}

const CHILD_ENV_ALLOWLIST = [
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PATH",
  "TMPDIR",
  "TZ",
] as const;

export function terminalDataPlaneChildEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
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
      env: terminalDataPlaneChildEnv(process.env),
      execArgv: process.execArgv,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
}

export function attachBrowserOnDataSocket(
  deps: {
    dataSockets: Pick<DaemonDataSockets, "routeTerminal" | "unrouteTerminal">;
    router: Pick<TerminalDataPlaneRouter, "attachBrowser" | "hasAttachInFlight">;
  },
  args: DataPlaneAttachArgs,
): string | null {
  if (!deps.dataSockets.routeTerminal(args)) {
    return null;
  }
  let attachId: string | null = null;
  try {
    attachId = deps.router.attachBrowser(args);
  } finally {
    if (attachId === null && !deps.router.hasAttachInFlight(args.terminalId)) {
      deps.dataSockets.unrouteTerminal(args.terminalId);
    }
  }
  return attachId;
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
  const router = new TerminalDataPlaneRouter(
    supervisor,
    options.lifecycle,
    (terminalId) => dataSockets.unrouteTerminal(terminalId),
  );
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
    attach: (args) => attachBrowserOnDataSocket({ dataSockets, router }, args),
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
  const unsubscribe = options.daemons.subscribe((change) => {
    try {
      dataSockets.handleSessionChange(change);
    } catch (error) {
      options.logger.warn(
        { err: error, sessionId: change.sessionId },
        "Terminal data plane could not follow a daemon session change",
      );
    }
  });
  return {
    get attachedSocketCount() {
      return router.attachedSocketCount;
    },
    get state() {
      return supervisor.state;
    },
    isSessionAttached: (daemonSessionId) =>
      dataSockets.isAttached(daemonSessionId),
    isTerminalRouted: (terminalId) => dataSockets.isRouted(terminalId),
    stop: () => {
      unsubscribe();
      dataSockets.stop();
      supervisor.stop();
    },
  };
}
