import { describe, expect, it } from "vitest";
import {
  createTerminalGridByteMarkerScanner,
  createTerminalGridMarker,
  createTerminalGridMarkerScanner,
  findLastTerminalGridMarker,
  parseTerminalGridMarker,
  readTerminalOutputLines,
  TERMINAL_GRID_OSC_IDENTIFIER,
} from "../src/index.js";

describe("terminal grid markers", () => {
  it("parses namespaced grid payloads within the terminal bounds", () => {
    expect(TERMINAL_GRID_OSC_IDENTIFIER).toBe(7791);
    expect(parseTerminalGridMarker("bb-grid;120;36")).toEqual({
      cols: 120,
      rows: 36,
    });
    expect(parseTerminalGridMarker("bb-grid;501;36")).toBeNull();
    expect(parseTerminalGridMarker("bb-grid;120;201")).toBeNull();
  });

  it("strips split markers without delaying following bytes", () => {
    const marker = createTerminalGridMarker({ cols: 51, rows: 16 });
    const scanner = createTerminalGridMarkerScanner();
    expect(scanner.push(`before${marker.slice(0, 11)}`)).toEqual({
      text: "before",
      markers: [],
    });
    expect(scanner.push(`${marker.slice(11)}after`)).toEqual({
      text: "after",
      markers: [{ cols: 51, rows: 16 }],
    });
    expect(scanner.flush()).toBe("");
  });

  it("preserves non-UTF8 bytes while removing an in-band marker", () => {
    const scanner = createTerminalGridByteMarkerScanner();
    const marker = new TextEncoder().encode(
      createTerminalGridMarker({ cols: 80, rows: 24 }),
    );
    const first = scanner.push(
      Uint8Array.from([0xff, ...marker.subarray(0, 8)]),
    );
    const second = scanner.push(Uint8Array.from([...marker.subarray(8), 0xfe]));
    expect([...first.bytes]).toEqual([0xff]);
    expect([...second.bytes]).toEqual([0xfe]);
    expect(second.markers).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("finds the latest complete marker and omits markers from text lines", () => {
    const oldGrid = createTerminalGridMarker({ cols: 80, rows: 24 });
    const newGrid = createTerminalGridMarker({ cols: 51, rows: 16 });
    expect(findLastTerminalGridMarker(`${oldGrid}a${newGrid}b`)).toBe(newGrid);
    expect(
      readTerminalOutputLines(`${oldGrid}first\n${newGrid}second\n`),
    ).toEqual(["first", "second"]);
  });
});
