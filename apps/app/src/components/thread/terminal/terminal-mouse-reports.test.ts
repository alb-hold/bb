import { describe, expect, it } from "vitest";
import { dropMouseReportsWithoutPosition } from "./terminal-mouse-reports";

describe("dropMouseReportsWithoutPosition", () => {
  it("drops the SGR wheel reports a touch fling emits without coordinates", () => {
    expect(
      dropMouseReportsWithoutPosition(
        "\x1b[<65;NaN;NaNM\x1b[<64;NaN;NaNM\x1b[<65;NaN;NaNM",
      ),
    ).toBe("");
  });

  it("keeps wheel reports that carry a position", () => {
    const reports = "\x1b[<65;12;30M\x1b[<64;1;1M\x1b[<0;5;7m";
    expect(dropMouseReportsWithoutPosition(reports)).toBe(reports);
  });

  it("drops positionless X10 reports and keeps the surrounding input", () => {
    expect(dropMouseReportsWithoutPosition("a\x1b[Ma\0\0b\x1b[M`!!c")).toBe(
      "ab\x1b[M`!!c",
    );
  });

  it("leaves typed text that mentions NaN alone", () => {
    expect(dropMouseReportsWithoutPosition("NaN;NaNM")).toBe("NaN;NaNM");
  });
});
