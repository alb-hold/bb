import type { Terminal as XTermTerminal } from "@xterm/xterm";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  terminalSurfaceScale,
} from "./terminal-grid-presentation";

export function mountTerminalReplayPreview({
  container,
  initialFitGrid,
  isOwner,
  terminal,
}: {
  container: HTMLDivElement;
  initialFitGrid: { cols: number; rows: number } | null;
  isOwner: () => boolean;
  terminal: XTermTerminal;
}): {
  dispose(): void;
  resize(cols: number, rows: number): Promise<void>;
  setFitGrid(cols: number, rows: number): void;
  push(bytes: Uint8Array, callback: () => void): void;
} {
  const parent = container.parentElement;
  if (!parent) throw new Error("Terminal replay preview requires a parent");

  const previousOpacity = container.style.opacity;
  const preview = document.createElement("div");
  preview.dataset.terminalReplayPreview = "";
  preview.dataset.gridCols = String(terminal.cols);
  preview.dataset.gridRows = String(terminal.rows);
  Object.assign(preview.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    paddingLeft: "0.5rem",
    pointerEvents: "none",
    zIndex: "5",
  });
  container.style.opacity = "0";
  parent.append(preview);
  terminal.open(preview);
  let fitGrid = initialFitGrid;
  let latestPtyGrid = { cols: terminal.cols, rows: terminal.rows };
  let surfaceScale =
    fitGrid === null ? 1 : terminalSurfaceScale(latestPtyGrid, fitGrid);
  const detachPointerCoordinates = terminal.element
    ? attachTerminalScalePointerCoordinates(
        terminal.element,
        () => surfaceScale,
      )
    : () => undefined;
  const updateSurfaceScale = () => {
    if (fitGrid === null) return;
    surfaceScale = terminalSurfaceScale(latestPtyGrid, fitGrid);
    if (terminal.element) {
      applyTerminalSurfaceScale(terminal.element, surfaceScale);
    }
  };
  updateSurfaceScale();
  const outputPipeline = createTerminalOutputPipeline(
    {
      resize: (cols, rows) => terminal.resize(cols, rows),
      write: (bytes, callback) => terminal.write(bytes, callback),
    },
    undefined,
    undefined,
    { resizeMarkerGrids: false },
  );

  let disposed = false;
  const updateVisibility = () => {
    updateSurfaceScale();
    preview.style.visibility =
      fitGrid !== null &&
      canRevealTerminalSurface({
        fitGrid,
        isOwner: isOwner(),
        ptyGrid: latestPtyGrid,
        rendererGrid: { cols: terminal.cols, rows: terminal.rows },
      })
        ? "visible"
        : "hidden";
  };
  const refreshVisibility = () => updateVisibility();
  document.addEventListener("focusin", refreshVisibility);
  document.addEventListener("focusout", refreshVisibility);
  window.addEventListener("focus", refreshVisibility);
  window.addEventListener("blur", refreshVisibility);
  updateVisibility();
  return {
    resize(cols, rows) {
      if (disposed) return Promise.resolve();
      latestPtyGrid = { cols, rows };
      updateVisibility();
      return new Promise((resolve) => {
        outputPipeline.setGrid(cols, rows, () => {
          if (!disposed) {
            preview.dataset.gridCols = String(cols);
            preview.dataset.gridRows = String(rows);
            updateVisibility();
          }
          resolve();
        });
      });
    },
    setFitGrid(cols, rows) {
      if (disposed) return;
      fitGrid = { cols, rows };
      updateSurfaceScale();
      updateVisibility();
    },
    push(bytes, callback) {
      if (!disposed) outputPipeline.push(bytes, callback);
      else callback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("focusin", refreshVisibility);
      document.removeEventListener("focusout", refreshVisibility);
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
      detachPointerCoordinates();
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
    },
  };
}
