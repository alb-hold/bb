import { describe, expect, it } from "vitest";
import {
  createTerminalGridByteMarkerScanner,
  createTerminalGridMarker,
} from "../src/terminal-grid.js";
import { createGridScannerOracle } from "./terminal-grid-oracle.js";

const encoder = new TextEncoder();
const marker = createTerminalGridMarker({ cols: 120, rows: 36 });
const sample = encoder.encode(
  `🌍\u001b[31mtext\u001b]0;title\u0007${marker}é終\u001b]52;c;YQ==\u0007\u001b]7791;bb-grid;501;200\u0007\u001b]oops\u0007\u001b[0m`,
);

function compare(parts: Uint8Array[]) {
  const actual = createTerminalGridByteMarkerScanner();
  const oracle = createGridScannerOracle();
  const anchors: Array<{ offset: number; cols: number; rows: number }> = [];
  const expectedAnchors: typeof anchors = [];
  let offset = 0;
  let expectedOffset = 0;
  for (const part of parts) {
    const result = actual.pushOperations(part);
    const expected = oracle.pushOperations(part);
    expect(result.hasPending).toBe(expected.hasPending);
    expect(result.operations).toHaveLength(expected.operations.length);
    for (let index = 0; index < result.operations.length; index++) {
      const operation = result.operations[index]!;
      const expectedOperation = expected.operations[index]!;
      if (operation.type === "bytes" && expectedOperation.type === "bytes") {
        let identical =
          operation.bytes.length === expectedOperation.bytes.length;
        for (let byte = 0; identical && byte < operation.bytes.length; byte++)
          identical = operation.bytes[byte] === expectedOperation.bytes[byte];
        if (!identical)
          throw new Error(`Scanner bytes diverged at operation ${index}`);
      } else {
        expect(operation).toEqual(expectedOperation);
      }
    }
    for (const operation of result.operations) {
      if (operation.type === "bytes") offset += operation.bytes.length;
      else anchors.push({ offset, ...operation.grid });
    }
    for (const operation of expected.operations) {
      if (operation.type === "bytes") expectedOffset += operation.bytes.length;
      else expectedAnchors.push({ offset: expectedOffset, ...operation.grid });
    }
  }
  expect(actual.flush()).toEqual(oracle.flush());
  expect(anchors).toEqual(expectedAnchors);
}

describe("terminal grid scanner equivalence", () => {
  it("matches the previous scanner across every two- and three-part marker split", () => {
    for (let first = 0; first <= sample.length; first++) {
      compare([sample.subarray(0, first), sample.subarray(first)]);
    }
    const candidate = encoder.encode(
      `before${marker}after\u001b]7791;bb-grid;120;`,
    );
    for (let first = 0; first <= candidate.length; first++) {
      for (let second = first; second <= candidate.length; second++) {
        compare([
          candidate.subarray(0, first),
          candidate.subarray(first, second),
          candidate.subarray(second),
        ]);
      }
    }
    compare([
      encoder.encode("\u001b]"),
      encoder.encode("false prefix🌍"),
      Uint8Array.of(0xff, 0x80),
    ]);
  });

  it("matches a six MiB mixed replay with deterministic random chunk boundaries", () => {
    const bytes = new Uint8Array(6 * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += sample.length)
      bytes.set(sample.subarray(0, bytes.length - offset), offset);
    let seed = 0x38c0ffee;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length;) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const size = 1 + (seed % 32768);
      parts.push(bytes.subarray(offset, offset + size));
      offset += size;
    }
    compare(parts);
  });
});
