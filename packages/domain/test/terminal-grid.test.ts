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

const encode = (text: string) => new TextEncoder().encode(text);
const combine = (parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

describe("terminal grid markers", () => {
  it("preserves ordered binary spans and incomplete or invalid markers under every split", () => {
    const marker = createTerminalGridMarker({ cols: 120, rows: 36 });
    const invalid = "\u001b]7791;bb-grid;501;201\u0007";
    const text = `before\u001b[31m${marker}after${invalid}${marker}\u001b]7791;bb-grid;12`;
    const bytes = Uint8Array.from([...encode(text), 0xff, 0x80]);
    const expected = combine([
      encode(`before\u001b[31mafter${invalid}\u001b]7791;bb-grid;12`),
      Uint8Array.of(0xff, 0x80),
    ]);
    for (let split = 0; split <= bytes.length; split++) {
      const scanner = createTerminalGridByteMarkerScanner();
      const first = scanner.pushOperations(bytes.subarray(0, split));
      const second = scanner.pushOperations(bytes.subarray(split));
      const operations = [...first.operations, ...second.operations];
      expect(
        combine([
          ...operations.flatMap((operation) =>
            operation.type === "bytes" ? [operation.bytes] : [],
          ),
          scanner.flush(),
        ]),
      ).toEqual(expected);
      expect(
        operations.flatMap((operation) =>
          operation.type === "grid" ? [operation.grid] : [],
        ),
      ).toEqual([
        { cols: 120, rows: 36 },
        { cols: 120, rows: 36 },
      ]);
    }
  });

  it("holds a marker one byte at a time and flushes an unfinished candidate", () => {
    const scanner = createTerminalGridByteMarkerScanner();
    const grids = [];
    for (const byte of encode(createTerminalGridMarker({ cols: 1, rows: 1 }))) {
      grids.push(...scanner.pushOperations(Uint8Array.of(byte)).operations);
    }
    expect(grids).toEqual([{ type: "grid", grid: { cols: 1, rows: 1 } }]);
    scanner.pushOperations(encode("\u001b]7791;bb-grid;120;"));
    expect(new TextDecoder().decode(scanner.flush())).toBe(
      "\u001b]7791;bb-grid;120;",
    );
  });
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
