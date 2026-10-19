export const TERMINAL_GRID_OSC_IDENTIFIER = 7791;
export const TERMINAL_GRID_OSC_PREFIX = "\u001b]7791;bb-grid;";

export interface TerminalGrid {
  cols: number;
  rows: number;
}

export interface TerminalGridMarkerScan {
  text: string;
  markers: TerminalGrid[];
}

export interface TerminalGridByteMarkerScan {
  bytes: Uint8Array;
  markers: TerminalGrid[];
}

export type TerminalGridByteOperation =
  | { type: "bytes"; bytes: Uint8Array }
  | { type: "grid"; grid: TerminalGrid };

export interface TerminalGridByteOperationScan {
  operations: TerminalGridByteOperation[];
  hasPending: boolean;
}

export function createTerminalGridMarker(grid: TerminalGrid): string {
  return `${TERMINAL_GRID_OSC_PREFIX}${grid.cols};${grid.rows}\u0007`;
}

export function parseTerminalGridMarker(payload: string): TerminalGrid | null {
  const match = /^bb-grid;([1-9]\d{0,2});([1-9]\d{0,2})$/u.exec(payload);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols > 500 || rows > 200) return null;
  return { cols, rows };
}

export function createTerminalGridMarkerScanner(): {
  flush(): string;
  push(text: string): TerminalGridMarkerScan;
} {
  let pending = "";
  return {
    flush(): string {
      const text = pending;
      pending = "";
      return text;
    },
    push(text: string): TerminalGridMarkerScan {
      const output: string[] = [];
      const markers: TerminalGrid[] = [];
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
                markers.push(grid);
                pending = "";
                break;
              }
            }
            if (isPossibleTerminalGridPayloadPrefix(payload)) break;
          }
          output.push(pending[0] ?? "");
          pending = pending.slice(1);
        }
      }
      return { text: output.join(""), markers };
    },
  };
}

export function createTerminalGridByteMarkerScanner(): {
  flush(): Uint8Array;
  push(bytes: Uint8Array): TerminalGridByteMarkerScan;
  pushOperations(bytes: Uint8Array): TerminalGridByteOperationScan;
} {
  const scanner = createOrderedTerminalGridMarkerScanner();
  return {
    flush(): Uint8Array {
      return toByteString(scanner.flush());
    },
    push(bytes: Uint8Array): TerminalGridByteMarkerScan {
      const result = scanner.push(fromByteString(bytes));
      return {
        bytes: toByteString(
          result.operations
            .filter((operation) => operation.type === "bytes")
            .map((operation) => operation.bytes)
            .join(""),
        ),
        markers: result.operations.flatMap((operation) =>
          operation.type === "grid" ? [operation.grid] : [],
        ),
      };
    },
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

export function stripTerminalGridMarkers(text: string): string {
  const scanner = createTerminalGridMarkerScanner();
  const { text: filtered } = scanner.push(text);
  return filtered + scanner.flush();
}

export function findLastTerminalGridMarker(text: string): string | null {
  const scanner = createTerminalGridMarkerScanner();
  const { markers } = scanner.push(text);
  const grid = markers.at(-1);
  return grid === undefined ? null : createTerminalGridMarker(grid);
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
