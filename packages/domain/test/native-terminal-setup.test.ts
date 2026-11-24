import { describe, expect, it } from "vitest";
import { nativeTerminalMayNeedSetup } from "../src/native-terminal.js";

describe("native setup cue", () => {
  const terminal = {
    status: "running",
    createdAt: 1000,
    lastUserInputAt: null,
  };
  it("waits twelve seconds, then cues an unbound untouched CLI", () => {
    expect(
      nativeTerminalMayNeedSetup({
        nativeSessionId: null,
        awaitingSessionStart: false,
        terminal,
        now: 12999,
      }),
    ).toBe(false);
    expect(
      nativeTerminalMayNeedSetup({
        nativeSessionId: null,
        awaitingSessionStart: false,
        terminal,
        now: 13000,
      }),
    ).toBe(true);
  });
  it("rearms twelve seconds after the latest input, unless the session binds", () => {
    const afterInput = { ...terminal, lastUserInputAt: 20000 };
    for (const [now, expected] of [
      [31999, false],
      [32000, true],
    ] as const) {
      expect(
        nativeTerminalMayNeedSetup({
          nativeSessionId: null,
          awaitingSessionStart: false,
          terminal: afterInput,
          now,
        }),
      ).toBe(expected);
      expect(
        nativeTerminalMayNeedSetup({
          nativeSessionId: "bound",
          awaitingSessionStart: false,
          terminal: afterInput,
          now,
        }),
      ).toBe(false);
    }
    expect(
      nativeTerminalMayNeedSetup({
        nativeSessionId: null,
        awaitingSessionStart: false,
        terminal: { ...terminal, lastUserInputAt: 500 },
        now: 12999,
      }),
    ).toBe(false);
  });
  it("clears on input or binding, and excludes absent and ended terminals", () => {
    for (const args of [
      { nativeSessionId: "bound", awaitingSessionStart: false, terminal },
      {
        nativeSessionId: null,
        awaitingSessionStart: false,
        terminal: { ...terminal, lastUserInputAt: 13001 },
      },
      {
        nativeSessionId: null,
        awaitingSessionStart: false,
        terminal: { ...terminal, status: "exited" },
      },
      { nativeSessionId: null, awaitingSessionStart: false, terminal: null },
    ])
      expect(nativeTerminalMayNeedSetup({ ...args, now: 20000 })).toBe(false);
  });
  it("cues a pre-assigned session until its started signal arrives", () => {
    const base = { nativeSessionId: "preassigned", terminal };
    expect(
      nativeTerminalMayNeedSetup({
        ...base,
        awaitingSessionStart: true,
        now: 12999,
      }),
    ).toBe(false);
    expect(
      nativeTerminalMayNeedSetup({
        ...base,
        awaitingSessionStart: true,
        now: 13000,
      }),
    ).toBe(true);
    expect(
      nativeTerminalMayNeedSetup({
        ...base,
        awaitingSessionStart: false,
        now: 13000,
      }),
    ).toBe(false);
  });
});
