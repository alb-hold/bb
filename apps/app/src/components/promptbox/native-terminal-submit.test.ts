import { describe, expect, it } from "vitest";
import {
  NATIVE_TERMINAL_SUPPORT_PENDING_REASON,
  nativeTerminalSupportPendingReason,
} from "./native-terminal-submit";

describe("nativeTerminalSupportPendingReason", () => {
  it("blocks a requested terminal thread while provider support is unknown", () => {
    expect(nativeTerminalSupportPendingReason(true, undefined)).toBe(
      NATIVE_TERMINAL_SUPPORT_PENDING_REASON,
    );
  });

  it.each([
    [true, true],
    [true, false],
    [false, undefined],
    [false, true],
    [false, false],
  ] as const)(
    "does not block when requested=%s and support=%s",
    (requested, support) => {
      expect(nativeTerminalSupportPendingReason(requested, support)).toBeNull();
    },
  );
});
