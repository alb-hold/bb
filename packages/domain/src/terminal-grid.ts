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
  const prefix = new TextEncoder().encode(TERMINAL_GRID_OSC_PREFIX);
  let pending = new Uint8Array(0);
  const scan = (input: Uint8Array): TerminalGridByteOperationScan => {
    let bytes = input;
    if (pending.length > 0) {
      bytes = new Uint8Array(pending.length + input.length);
      bytes.set(pending);
      bytes.set(input, pending.length);
      pending = new Uint8Array(0);
    }
    const operations: TerminalGridByteOperation[] = [];
    let outputStart = 0;
    let searchAt = 0;
    while (searchAt < bytes.length) {
      const start = bytes.indexOf(27, searchAt);
      if (start < 0) break;
      let matched = 0;
      while (
        matched < prefix.length &&
        start + matched < bytes.length &&
        bytes[start + matched] === prefix[matched]
      )
        matched++;
      let hold = matched < prefix.length && start + matched === bytes.length;
      if (matched === prefix.length) {
        let end = start + matched;
        while (
          end < bytes.length &&
          end - start - matched <= 8 &&
          bytes[end] !== 7
        )
          end++;
        const payload = fromByteString(bytes.subarray(start + matched, end));
        const grid =
          bytes[end] === 7
            ? parseTerminalGridMarker(`bb-grid;${payload}`)
            : null;
        if (grid !== null) {
          if (start > outputStart)
            operations.push({
              type: "bytes",
              bytes: bytes.subarray(outputStart, start),
            });
          operations.push({ type: "grid", grid });
          outputStart = end + 1;
          searchAt = outputStart;
          continue;
        }
        hold =
          end === bytes.length && isPossibleTerminalGridPayloadPrefix(payload);
      }
      if (hold) {
        if (start > outputStart)
          operations.push({
            type: "bytes",
            bytes: bytes.subarray(outputStart, start),
          });
        pending = bytes.slice(start);
        return { operations, hasPending: true };
      }
      searchAt = start + 1;
    }
    if (outputStart < bytes.length)
      operations.push({ type: "bytes", bytes: bytes.subarray(outputStart) });
    return { operations, hasPending: false };
  };
  return {
    flush() {
      const bytes = pending;
      pending = new Uint8Array(0);
      return bytes;
    },
    push(bytes) {
      const result = scan(bytes);
      const parts = result.operations.flatMap((operation) =>
        operation.type === "bytes" ? [operation.bytes] : [],
      );
      const output = new Uint8Array(
        parts.reduce((size, part) => size + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return {
        bytes: output,
        markers: result.operations.flatMap((operation) =>
          operation.type === "grid" ? [operation.grid] : [],
        ),
      };
    },
    pushOperations: scan,
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
