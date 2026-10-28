import { describe, expect, it } from "vitest";
import {
  OSC_52_AUTO_COPY_MAX_BYTES,
  OSC_52_AUTO_COPY_WINDOW_MS,
  shouldAutoCopyOsc52,
} from "./terminal-osc52-policy";

const base = {
  copyOnSelect: true,
  lastUserInputAt: 10_000,
  now: 10_000,
  text: "copied",
};

describe("OSC 52 auto-copy policy", () => {
  it("allows a small copy at the moment of input and at the edge of the window", () => {
    expect(shouldAutoCopyOsc52(base)).toBe(true);
    expect(
      shouldAutoCopyOsc52({
        ...base,
        now: base.lastUserInputAt + OSC_52_AUTO_COPY_WINDOW_MS,
      }),
    ).toBe(true);
  });

  it("refuses without input, outside the window, or when the clock went backwards", () => {
    expect(shouldAutoCopyOsc52({ ...base, lastUserInputAt: null })).toBe(false);
    expect(
      shouldAutoCopyOsc52({
        ...base,
        now: base.lastUserInputAt + OSC_52_AUTO_COPY_WINDOW_MS + 1,
      }),
    ).toBe(false);
    expect(
      shouldAutoCopyOsc52({ ...base, now: base.lastUserInputAt - 1 }),
    ).toBe(false);
  });

  it("refuses when copy-on-select is off", () => {
    expect(shouldAutoCopyOsc52({ ...base, copyOnSelect: false })).toBe(false);
  });

  it("caps the decoded size in bytes, not characters", () => {
    expect(
      shouldAutoCopyOsc52({
        ...base,
        text: "a".repeat(OSC_52_AUTO_COPY_MAX_BYTES),
      }),
    ).toBe(true);
    expect(
      shouldAutoCopyOsc52({
        ...base,
        text: "a".repeat(OSC_52_AUTO_COPY_MAX_BYTES + 1),
      }),
    ).toBe(false);
    expect(
      shouldAutoCopyOsc52({
        ...base,
        text: "✓".repeat(Math.ceil(OSC_52_AUTO_COPY_MAX_BYTES / 3) + 1),
      }),
    ).toBe(false);
  });
});
