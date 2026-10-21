import { createTerminalGridByteMarkerScanner } from "@bb/domain";
import type { TerminalGrid } from "@bb/domain";

type TerminalWriter = {
  resize(cols: number, rows: number): void;
  write(data: Uint8Array, callback: () => void): void;
};

type Operation =
  | { type: "write"; bytes: Uint8Array }
  | { type: "start"; callback: () => void }
  | {
      type: "grid";
      grid: TerminalGrid;
      callback?: () => void;
      resize: boolean;
    }
  | { type: "ack"; callback: () => void };

export function createTerminalOutputPipeline(
  terminal: TerminalWriter,
  onGrid?: (grid: TerminalGrid, apply: boolean) => void,
  onResize?: (cols: number, rows: number) => void,
  options: { resizeMarkerGrids?: boolean } = {},
): {
  push(
    bytes: Uint8Array,
    callback: () => void,
    applyMarkerGrids?: boolean,
    onStart?: () => void,
  ): void;
  setGrid(cols: number, rows: number, callback?: () => void): void;
} {
  const scanner = createTerminalGridByteMarkerScanner();
  const operations: Operation[] = [];
  const callbacksHeldForMarker: Array<() => void> = [];
  let draining = false;
  let pendingWrites: Promise<void>[] = [];
  let pendingMarkerGridsApply = true;

  const enqueue = (operation: Operation) => {
    const previous = operations.at(-1);
    if (operation.type === "grid" && previous?.type === "grid") {
      const callbacks = [previous.callback, operation.callback].filter(
        (callback): callback is () => void => callback !== undefined,
      );
      operations[operations.length - 1] = {
        ...operation,
        callback:
          callbacks.length === 0
            ? undefined
            : () => callbacks.forEach((callback) => callback()),
      };
    } else {
      operations.push(operation);
    }
    void drain();
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (operations.length > 0) {
        const operation = operations.shift();
        if (operation === undefined) continue;
        if (operation.type === "write") {
          const write = new Promise<void>((resolve) => {
            terminal.write(operation.bytes, resolve);
          });
          pendingWrites.push(write);
          void write.then(() => {
            pendingWrites = pendingWrites.filter(
              (pending) => pending !== write,
            );
          });
          continue;
        }
        if (operation.type === "start") {
          await Promise.all(pendingWrites);
          operation.callback();
          continue;
        }
        if (operation.type === "grid") {
          await Promise.all(pendingWrites);
          if (operation.resize) {
            terminal.resize(operation.grid.cols, operation.grid.rows);
            onResize?.(operation.grid.cols, operation.grid.rows);
          }
          operation.callback?.();
          continue;
        }
        const writeBarrier = [...pendingWrites];
        void Promise.all(writeBarrier).then(operation.callback);
      }
    } finally {
      draining = false;
      if (operations.length > 0) void drain();
    }
  };

  return {
    push(bytes, callback, applyMarkerGrids = true, onStart) {
      if (onStart) enqueue({ type: "start", callback: onStart });
      const result = scanner.pushOperations(bytes);
      const applyScannedMarkerGrids =
        applyMarkerGrids && pendingMarkerGridsApply;
      pendingMarkerGridsApply = result.hasPending
        ? applyScannedMarkerGrids
        : true;
      for (const operation of result.operations) {
        if (operation.type === "bytes" && operation.bytes.length > 0) {
          enqueue({ type: "write", bytes: operation.bytes });
        } else if (operation.type === "grid") {
          onGrid?.(operation.grid, applyScannedMarkerGrids);
          enqueue({
            type: "grid",
            grid: operation.grid,
            resize:
              applyScannedMarkerGrids && (options.resizeMarkerGrids ?? true),
          });
        }
      }
      if (result.hasPending) {
        callbacksHeldForMarker.push(callback);
      } else {
        enqueue({
          type: "ack",
          callback: () => {
            for (const held of callbacksHeldForMarker.splice(0)) held();
            callback();
          },
        });
      }
    },
    setGrid(cols, rows, callback) {
      enqueue({
        type: "grid",
        grid: { cols, rows },
        callback,
        resize: true,
      });
    },
  };
}
