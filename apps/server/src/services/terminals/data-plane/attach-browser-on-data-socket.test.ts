import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DataPlaneAttachArgs } from "./data-plane-router.js";
import { attachBrowserOnDataSocket } from "./terminal-data-plane.js";

const args: DataPlaneAttachArgs = {
  daemonSessionId: "session_1",
  outputAcks: false,
  resizeAcks: false,
  sequenceBase: 0,
  request: { url: "/ws/terminals/term_1", headers: [], headBase64: "" },
  sinceSeq: 0,
  socket: {} as Socket,
  terminalId: "term_1",
};

function createFixture(options: {
  attach: () => string | null;
  inFlight?: boolean;
  routed?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      dataSockets: {
        routeTerminal: vi.fn(() => {
          calls.push("route");
          return options.routed ?? true;
        }),
        unrouteTerminal: vi.fn(() => {
          calls.push("unroute");
        }),
      },
      router: {
        attachBrowser: vi.fn(() => {
          calls.push("attach");
          return options.attach();
        }),
        hasAttachInFlight: vi.fn(() => options.inFlight ?? false),
      },
    },
  };
}

describe("attachBrowserOnDataSocket", () => {
  it("keeps the route when the helper takes the browser", () => {
    const { calls, deps } = createFixture({ attach: () => "attach_1" });
    expect(attachBrowserOnDataSocket(deps, args)).toBe("attach_1");
    expect(calls).toEqual(["route", "attach"]);
  });

  it("does not try to attach when the route cannot be set", () => {
    const { calls, deps } = createFixture({ attach: () => "x", routed: false });
    expect(attachBrowserOnDataSocket(deps, args)).toBeNull();
    expect(calls).toEqual(["route"]);
  });

  it("rolls the route back when the helper cannot take the browser", () => {
    const { calls, deps } = createFixture({ attach: () => null });
    expect(attachBrowserOnDataSocket(deps, args)).toBeNull();
    expect(calls).toEqual(["route", "attach", "unroute"]);
    expect(deps.dataSockets.unrouteTerminal).toHaveBeenCalledWith("term_1");
  });

  it("rolls the route back and rethrows when attaching throws", () => {
    const { calls, deps } = createFixture({
      attach: () => {
        throw new Error("boom");
      },
    });
    expect(() => attachBrowserOnDataSocket(deps, args)).toThrow("boom");
    expect(calls).toEqual(["route", "attach", "unroute"]);
  });

  it("leaves the route alone when another browser of the terminal is attached or pending", () => {
    const { calls, deps } = createFixture({ attach: () => null, inFlight: true });
    expect(attachBrowserOnDataSocket(deps, args)).toBeNull();
    expect(calls).toEqual(["route", "attach"]);
  });
});
