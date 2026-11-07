import { createTerminalGridByteMarkerScanner } from "@bb/domain";
import type { TerminalGrid } from "@bb/domain";

type TerminalWriter = {
  resize(cols: number, rows: number): void;
  write(data: Uint8Array, callback: () => void): void;
};

type Operation =
  | { type: "write"; bytes: Uint8Array; flush: boolean }
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
  options: {
    resizeMarkerGrids?: boolean;
    beforeResize?: () => void;
    afterResize?: () => void;
    flushReplay?: () => void;
  } = {},
): {
  push(
    bytes: Uint8Array,
    callback: () => void,
    applyMarkerGrids?: boolean,
    flush?: boolean,
  ): void;
  setGrid(cols: number, rows: number, callback?: () => void): void;
} {
  const scanner = createTerminalGridByteMarkerScanner();
  const operations: Array<Operation | undefined> = [];
  let operationHead = 0;
  const callbacksHeldForMarker: Array<() => void> = [];
  let draining = false;
  let lastWrite = Promise.resolve();
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
      while (operationHead < operations.length) {
        const operation = operations[operationHead];
        operations[operationHead++] = undefined;
        if (operation === undefined) continue;
        if (operation.type === "write") {
          lastWrite = new Promise<void>((resolve) => {
            terminal.write(operation.bytes, resolve);
            if (operation.flush) options.flushReplay?.();
          });
          continue;
        }
        if (operation.type === "grid") {
          await lastWrite;
          if (operation.resize) {
            options.beforeResize?.();
            terminal.resize(operation.grid.cols, operation.grid.rows);
            onResize?.(operation.grid.cols, operation.grid.rows);
            options.afterResize?.();
          }
          operation.callback?.();
          continue;
        }
        void lastWrite.then(operation.callback);
      }
    } finally {
      if (operationHead === operations.length) {
        operations.length = 0;
        operationHead = 0;
      }
      draining = false;
      if (operationHead < operations.length) void drain();
    }
  };

  return {
    push(bytes, callback, applyMarkerGrids = true, flush = false) {
      const result = scanner.pushOperations(bytes);
      const applyScannedMarkerGrids =
        applyMarkerGrids && pendingMarkerGridsApply;
      pendingMarkerGridsApply = result.hasPending
        ? applyScannedMarkerGrids
        : true;
      for (const operation of result.operations) {
        if (operation.type === "bytes" && operation.bytes.length > 0) {
          for (
            let offset = 0;
            offset < operation.bytes.length;
            offset += 16 * 1024
          ) {
            enqueue({
              type: "write",
              bytes: operation.bytes.subarray(offset, offset + 16 * 1024),
              flush,
            });
          }
        } else if (operation.type === "grid") {
          onGrid?.(operation.grid, applyScannedMarkerGrids);
          if (applyScannedMarkerGrids && (options.resizeMarkerGrids ?? true)) {
            enqueue({ type: "grid", grid: operation.grid, resize: true });
          }
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
