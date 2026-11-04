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
        terminal,
        now: 12999,
      }),
    ).toBe(false);
    expect(
      nativeTerminalMayNeedSetup({
        nativeSessionId: null,
        terminal,
        now: 13000,
      }),
    ).toBe(true);
  });
  it("clears on input or binding, and excludes absent and ended terminals", () => {
    for (const args of [
      { nativeSessionId: "bound", terminal },
      {
        nativeSessionId: null,
        terminal: { ...terminal, lastUserInputAt: 13001 },
      },
      { nativeSessionId: null, terminal: { ...terminal, status: "exited" } },
      { nativeSessionId: null, terminal: null },
    ])
      expect(nativeTerminalMayNeedSetup({ ...args, now: 20000 })).toBe(false);
  });
});
