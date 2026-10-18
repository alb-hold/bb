import { describe, expect, it, vi } from "vitest";
import { TERMINAL_DATA_PLANE_IPC_VERSION } from "../../../terminal-data-plane/ipc-contract.js";
import type { TerminalDataPlaneMainMessage } from "../../../terminal-data-plane/ipc-contract.js";
import { DaemonDataSockets } from "./daemon-data-sockets.js";
import { TerminalDataTicketStore } from "./terminal-data-ticket-store.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;

function createFixture() {
  const sent: TerminalDataPlaneMainMessage[] = [];
  const sockets = new DaemonDataSockets({
    capabilities: { forget: vi.fn(), negotiate: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn() },
    newRequestId: () => "request_1",
    rpc: { request: vi.fn() },
    setSessionDirectOutput: vi.fn(),
    tickets: new TerminalDataTicketStore(),
    transport: {
      isReady: false,
      pendingIpcBytes: 0,
      send: (message) => {
        sent.push(message);
        return true;
      },
    },
  });
  sockets.handleSessionChange({
    kind: "opened",
    hostId: "host_1",
    sessionId: "session_1",
  });
  sockets.handleChildMessage({
    v: V,
    type: "daemon.attached",
    daemonSessionId: "session_1",
  });
  return { sent, sockets };
}

const unroutes = (sent: TerminalDataPlaneMainMessage[]) =>
  sent.filter((message) => message.type === "terminal.unroute");

describe("DaemonDataSockets.unrouteTerminal", () => {
  it("tells the child to forget a routed terminal once and leaves the others routed", () => {
    const { sent, sockets } = createFixture();
    sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_a" });
    sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_b" });

    sockets.unrouteTerminal("term_a");
    sockets.unrouteTerminal("term_a");
    sockets.unrouteTerminal("term_unknown");

    expect(unroutes(sent)).toEqual([
      { v: V, type: "terminal.unroute", terminalId: "term_a" },
    ]);

    sockets.handleChildMessage({
      v: V,
      type: "daemon.detached",
      daemonSessionId: "session_1",
    });
    expect(unroutes(sent).map((message) => message.terminalId)).toEqual([
      "term_a",
      "term_b",
    ]);
    sockets.stop();
  });

  it("routes a terminal again when a browser attaches after it exited", () => {
    const { sent, sockets } = createFixture();
    sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_a" });
    sockets.unrouteTerminal("term_a");
    expect(
      sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_a" }),
    ).toBe(true);
    expect(sent.filter((message) => message.type === "terminal.route")).toHaveLength(
      2,
    );
  });
});

function createFaultyFixture(options: {
  directOutput?: () => void;
  sendOk: { value: boolean };
}) {
  const sent: TerminalDataPlaneMainMessage[] = [];
  const sockets = new DaemonDataSockets({
    capabilities: { forget: vi.fn(), negotiate: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn() },
    newRequestId: () => "request_1",
    retryDelaysMs: [],
    rpc: { request: vi.fn() },
    setSessionDirectOutput: options.directOutput ?? vi.fn(),
    tickets: new TerminalDataTicketStore(),
    transport: {
      isReady: false,
      pendingIpcBytes: 0,
      send: (message) => {
        sent.push(message);
        return options.sendOk.value;
      },
    },
  });
  sockets.handleSessionChange({
    kind: "opened",
    hostId: "host_1",
    sessionId: "session_1",
  });
  sockets.handleChildMessage({
    v: V,
    type: "daemon.attached",
    daemonSessionId: "session_1",
  });
  return { sent, sockets };
}

describe("DaemonDataSockets failure ordering", () => {
  it("does not record a route the helper never received", () => {
    const sendOk = { value: false };
    const { sockets } = createFaultyFixture({ sendOk });
    expect(
      sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_a" }),
    ).toBe(false);
    expect(sockets.isRouted("term_a")).toBe(false);
    sendOk.value = true;
    expect(
      sockets.routeTerminal({ daemonSessionId: "session_1", terminalId: "term_a" }),
    ).toBe(true);
    expect(sockets.isRouted("term_a")).toBe(true);
  });

  it("stays detached and tells the helper to drop the socket when direct output cannot be switched on", () => {
    const { sent, sockets } = createFaultyFixture({
      directOutput: () => {
        throw new Error("switch failed");
      },
      sendOk: { value: true },
    });
    expect(sockets.isAttached("session_1")).toBe(false);
    expect(sent).toContainEqual({
      v: V,
      type: "daemon.detach",
      daemonSessionId: "session_1",
    });
  });
});
