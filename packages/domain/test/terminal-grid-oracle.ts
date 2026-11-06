import {
  TERMINAL_GRID_OSC_PREFIX,
  parseTerminalGridMarker,
  type TerminalGrid,
  type TerminalGridByteOperationScan,
} from "../src/terminal-grid.js";
export function createGridScannerOracle() {
  const scanner = createOrderedTerminalGridMarkerScanner();
  return {
    flush: () => toByteString(scanner.flush()),
    pushOperations(bytes: Uint8Array): TerminalGridByteOperationScan {
      const result = scanner.push(fromByteString(bytes));
      return {
        operations: result.operations.map((operation) =>
          operation.type === "bytes"
            ? { type: "bytes", bytes: toByteString(operation.bytes) }
            : operation,
        ),
        hasPending: result.hasPending,
      };
    },
  };
}
function createOrderedTerminalGridMarkerScanner(): {
  flush(): string;
  push(text: string): {
    operations: Array<
      { type: "bytes"; bytes: string } | { type: "grid"; grid: TerminalGrid }
    >;
    hasPending: boolean;
  };
} {
  let pending = "";
  return {
    flush(): string {
      const text = pending;
      pending = "";
      return text;
    },
    push(text: string) {
      const operations: Array<
        { type: "bytes"; bytes: string } | { type: "grid"; grid: TerminalGrid }
      > = [];
      let output = "";
      const flushOutput = () => {
        if (output.length > 0)
          operations.push({ type: "bytes", bytes: output });
        output = "";
      };
      for (const character of text) {
        pending += character;
        while (pending.length > 0) {
          if (TERMINAL_GRID_OSC_PREFIX.startsWith(pending)) break;
          if (pending.startsWith(TERMINAL_GRID_OSC_PREFIX)) {
            const payload = pending.slice(TERMINAL_GRID_OSC_PREFIX.length);
            const complete = /^([1-9]\d{0,2});([1-9]\d{0,2})\u0007$/u.exec(
              payload,
            );
            if (complete) {
              const grid = parseTerminalGridMarker(
                `bb-grid;${complete[1]};${complete[2]}`,
              );
              if (grid !== null) {
                flushOutput();
                operations.push({ type: "grid", grid });
                pending = "";
                break;
              }
            }
            if (isPossibleTerminalGridPayloadPrefix(payload)) break;
          }
          output += pending[0] ?? "";
          pending = pending.slice(1);
        }
      }
      flushOutput();
      return { operations, hasPending: pending.length > 0 };
    },
  };
}

function isPossibleTerminalGridPayloadPrefix(payload: string): boolean {
  if (payload.length === 0) return true;
  if (payload.includes("\u0007")) return false;
  const parts = payload.split(";");
  if (parts.length > 2) return false;
  const [cols, rows] = parts;
  if (cols === undefined || !/^[1-9]\d{0,2}$/u.test(cols)) return false;
  if (rows === undefined) return true;
  return rows === "" || /^[1-9]\d{0,2}$/u.test(rows);
}

function fromByteString(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return result;
}

function toByteString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return bytes;
}
