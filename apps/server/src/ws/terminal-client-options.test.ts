import {
  TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
  TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { terminalClientProtocolOptions } from "./terminal-client-options.js";

describe("terminal client protocol options", () => {
  it("enables raw replay for originless clients", () => {
    expect(terminalClientProtocolOptions(undefined, "")).toEqual({
      rawReplay: true,
      resizeSeqEcho: false,
    });
  });

  it.each([
    TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
    TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
  ])("enables resize sequence echoes for %s", (protocol) => {
    expect(terminalClientProtocolOptions("https://bb.test", protocol)).toEqual({
      rawReplay: false,
      resizeSeqEcho: true,
    });
  });
});
