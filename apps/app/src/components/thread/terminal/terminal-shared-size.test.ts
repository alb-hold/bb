import { describe, expect, it } from "vitest";
import {
  nextSharedTerminalSize,
  terminalDisplaySize,
} from "./terminal-shared-size";

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

describe("nextSharedTerminalSize", () => {
  it("ignores a reported size that is the echo of this client's own repaint nudge", () => {
    expect(
      nextSharedTerminalSize(
        { cols: 132, rows: 46 },
        { cols: 131, rows: 46 },
        true,
      ),
    ).toBeNull();
  });

  it("applies a size another client chose, even while a nudge is in flight", () => {
    expect(
      nextSharedTerminalSize(
        { cols: 132, rows: 46 },
        { cols: 44, rows: 20 },
        false,
      ),
    ).toEqual({ cols: 44, rows: 20 });
  });

  it("reports no change when the size equals the current shared size", () => {
    expect(
      nextSharedTerminalSize(
        { cols: 132, rows: 46 },
        { cols: 132, rows: 46 },
        false,
      ),
    ).toBeNull();
  });

  it("takes the first reported size", () => {
    expect(
      nextSharedTerminalSize(null, { cols: 132, rows: 46 }, false),
    ).toEqual({ cols: 132, rows: 46 });
  });
});
