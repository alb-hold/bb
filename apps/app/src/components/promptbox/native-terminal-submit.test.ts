import { describe, expect, it } from "vitest";
import {
  NATIVE_TERMINAL_SUPPORT_PENDING_REASON,
  nativeTerminalPreferenceStored,
  nativeTerminalSupportPendingReason,
} from "./native-terminal-submit";

describe("nativeTerminalSupportPendingReason", () => {
  it("blocks an explicitly requested terminal thread while provider support is unknown", () => {
    expect(nativeTerminalSupportPendingReason(true, true, undefined)).toBe(
      NATIVE_TERMINAL_SUPPORT_PENDING_REASON,
    );
  });

  it.each([
    [true, false, undefined],
    [true, true, true],
    [true, true, false],
    [false, true, undefined],
    [false, false, undefined],
    [false, true, true],
  ] as const)(
    "does not block when requested=%s explicit=%s support=%s",
    (requested, explicit, support) => {
      expect(
        nativeTerminalSupportPendingReason(requested, explicit, support),
      ).toBeNull();
    },
  );
});

describe("nativeTerminalPreferenceStored", () => {
  it("is true only once the preference has been stored", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null };
    expect(nativeTerminalPreferenceStored("k", () => storage)).toBe(false);
    store.set("k", "true");
    expect(nativeTerminalPreferenceStored("k", () => storage)).toBe(true);
  });

  it("is false when storage is unavailable or throws", () => {
    expect(nativeTerminalPreferenceStored("k", () => undefined)).toBe(false);
    expect(
      nativeTerminalPreferenceStored("k", () => ({
        getItem: () => {
          throw new Error("blocked");
        },
      })),
    ).toBe(false);
  });
});
