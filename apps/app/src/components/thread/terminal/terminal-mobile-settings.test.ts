import { describe, expect, it } from "vitest";
import {
  clampTerminalFontSize,
  mobileKeyboardDockBottom,
  readTerminalMobileFontSize,
  writeTerminalMobileFontSize,
  TERMINAL_MOBILE_FONT_STORAGE_KEY,
} from "./terminal-mobile-settings";

describe("mobile terminal settings", () => {
  it("persists a bounded terminal font size in device storage", () => {
    const storage = new Map<string, string>();
    const adapter = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } satisfies Storage;
    expect(readTerminalMobileFontSize(adapter)).toBe(12);
    expect(writeTerminalMobileFontSize(adapter, 19)).toBe(19);
    expect(readTerminalMobileFontSize(adapter)).toBe(19);
    expect(storage.get(TERMINAL_MOBILE_FONT_STORAGE_KEY)).toBe("19");
    expect(clampTerminalFontSize(40)).toBe(28);
    expect(clampTerminalFontSize(4)).toBe(8);
  });

  it("keeps the control dock at the visual viewport bottom through focus changes", () => {
    expect(mobileKeyboardDockBottom(844, 0, 502)).toBe(342);
    expect(mobileKeyboardDockBottom(844, 120, 382)).toBe(342);
    expect(mobileKeyboardDockBottom(844, 0, 844)).toBe(0);
  });
});
