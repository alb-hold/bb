import { describe, expect, it } from "vitest";
import { terminalDisplaySize } from "./terminal-shared-size";

describe("terminalDisplaySize", () => {
  it("draws a wide screen at the narrower shared PTY size", () => {
    expect(
      terminalDisplaySize({ cols: 160, rows: 48 }, { cols: 44, rows: 20 }),
    ).toEqual({ cols: 44, rows: 20 });
  });

  it("never draws past the screen when the shared size is still larger", () => {
    expect(
      terminalDisplaySize({ cols: 44, rows: 20 }, { cols: 160, rows: 48 }),
    ).toEqual({ cols: 44, rows: 20 });
  });

  it("uses the fitted size before the server reports one", () => {
    expect(terminalDisplaySize({ cols: 90, rows: 30 }, null)).toEqual({
      cols: 90,
      rows: 30,
    });
  });
});
