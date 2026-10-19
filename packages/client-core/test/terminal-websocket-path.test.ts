import { describe, expect, it } from "vitest";
import { buildTerminalWebSocketPath } from "../src/terminal/terminal-websocket-path.js";

describe("buildTerminalWebSocketPath", () => {
  it("passes the device handoff owner token on the terminal attachment", () => {
    expect(
      buildTerminalWebSocketPath({
        terminalId: "term /one",
        handoffOwnerToken: "0123456789abcdefghij_-",
      }),
    ).toBe(
      "/ws/terminals/term%20%2Fone?handoffOwnerToken=0123456789abcdefghij_-",
    );
  });

  it("omits the owner token when one has not arrived yet", () => {
    expect(buildTerminalWebSocketPath({ terminalId: "term-1" })).toBe(
      "/ws/terminals/term-1",
    );
  });
});
