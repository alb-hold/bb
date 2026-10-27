import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { TerminalGrid } from "@bb/domain";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  readTerminalSurfaceScale,
  terminalSurfaceScale,
} from "./terminal-grid-presentation";

export function updateTerminalReplayPreviewPtyGrid(
  preview: { setPtyGrid(cols: number, rows: number): void } | null,
  grid: TerminalGrid,
  apply: boolean,
): void {
  if (apply) preview?.setPtyGrid(grid.cols, grid.rows);
}

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
  setPtyGrid(cols: number, rows: number): void;
  setFitGrid(cols: number, rows: number): void;
  push(bytes: Uint8Array, callback: () => void): void;
} {
  const parent = container.parentElement;
  if (!parent) throw new Error("Terminal replay preview requires a parent");

  const previousOpacity = container.style.opacity;
  const previousContainerType = container.style.containerType;
  const snapshotGrid = { cols: terminal.cols, rows: terminal.rows };
  container.style.containerType = "inline-size";
  const preview = document.createElement("div");
  const focusedElement = document.activeElement;
  preview.dataset.terminalReplayPreview = "";
  preview.dataset.gridCols = String(terminal.cols);
  preview.dataset.gridRows = String(terminal.rows);
  Object.assign(preview.style, {
    position: "absolute",
    inset: "0 16px 0 0",
    overflow: "hidden",
    overflowX: "hidden",
    paddingLeft: "0.5rem",
    pointerEvents: "none",
    zIndex: "5",
    containerType: "inline-size",
  });
  container.style.opacity = "0";
  parent.append(preview);
  terminal.open(preview);
  if (
    focusedElement instanceof HTMLElement &&
    focusedElement !== document.body &&
    focusedElement.isConnected &&
    document.activeElement !== focusedElement
  ) {
    focusedElement.focus({ preventScroll: true });
  }
  let fitGrid = initialFitGrid;
  let latestPtyGrid = { cols: terminal.cols, rows: terminal.rows };
  let shown = false;
  let snapshotWriteFinished = false;
  let authoritativeGridAvailable = false;
  let pendingWrites: Array<{ bytes: Uint8Array; callback: () => void }> = [];
  let surfaceScale =
    fitGrid === null ? 1 : terminalSurfaceScale(latestPtyGrid, fitGrid);
  const detachPointerCoordinates = terminal.element
    ? attachTerminalScalePointerCoordinates(terminal.element, () =>
        terminal.element ? readTerminalSurfaceScale(terminal.element) : 1,
      )
    : () => undefined;
  const updateSurfaceScale = () => {
    if (fitGrid === null) return;
    const wasVisible = preview.style.visibility === "visible";
    preview.style.visibility = "hidden";
    surfaceScale = terminalSurfaceScale(
      { cols: terminal.cols, rows: terminal.rows },
      fitGrid,
    );
    if (terminal.element) {
      applyTerminalSurfaceScale(terminal.element, surfaceScale);
    }
    const rendererWidth = container.getBoundingClientRect().width;
    const paintedWidth =
      terminal.element
        ?.querySelector<HTMLElement>(".xterm-screen")
        ?.getBoundingClientRect().width ?? 0;
    if (wasVisible && rendererWidth > 0 && paintedWidth <= rendererWidth + 1) {
      preview.style.visibility = "visible";
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
  const resizeObserver = new ResizeObserver(updateSurfaceScale);
  resizeObserver.observe(container);
  window.addEventListener("resize", updateSurfaceScale);
  const updateVisibility = () => {
    updateSurfaceScale();
    const localGridReady =
      fitGrid !== null &&
      terminal.cols === snapshotGrid.cols &&
      terminal.rows >= snapshotGrid.rows &&
      terminal.rows >= fitGrid.rows;
    preview.style.visibility =
      fitGrid !== null &&
      (shown ||
        localGridReady ||
        canRevealTerminalSurface({
          fitGrid,
          isOwner: isOwner(),
          ptyGrid: latestPtyGrid,
          rendererGrid: { cols: terminal.cols, rows: terminal.rows },
        }))
        ? "visible"
        : "hidden";
    if (preview.style.visibility === "visible") shown = true;
  };
  const refreshVisibility = () => updateVisibility();
  const flushPendingWrites = () => {
    if (!snapshotWriteFinished || !authoritativeGridAvailable) return;
    for (const write of pendingWrites.splice(0)) {
      outputPipeline.push(write.bytes, write.callback);
    }
  };
  document.addEventListener("focusin", refreshVisibility);
  document.addEventListener("focusout", refreshVisibility);
  window.addEventListener("focus", refreshVisibility);
  window.addEventListener("blur", refreshVisibility);
  if (fitGrid !== null && fitGrid.rows > terminal.rows) {
    terminal.resize(snapshotGrid.cols, fitGrid.rows);
  }
  updateVisibility();
  const setPtyGrid = (cols: number, rows: number) => {
    if (disposed) return;
    latestPtyGrid = { cols, rows };
    authoritativeGridAvailable = true;
    updateVisibility();
    flushPendingWrites();
  };
  return {
    resize(cols, rows) {
      if (disposed) return Promise.resolve();
      latestPtyGrid = { cols, rows };
      return new Promise((resolve) => {
        outputPipeline.setGrid(cols, rows, () => {
          if (!disposed) {
            preview.dataset.gridCols = String(cols);
            preview.dataset.gridRows = String(rows);
            authoritativeGridAvailable = true;
            updateVisibility();
            flushPendingWrites();
          }
          resolve();
        });
      });
    },
    setPtyGrid,
    setFitGrid(_cols, rows) {
      if (disposed) return;
      fitGrid = { cols, rows };
      if (terminal.cols === snapshotGrid.cols && rows > terminal.rows) {
        terminal.resize(snapshotGrid.cols, rows);
      }
      updateSurfaceScale();
      updateVisibility();
    },
    push(bytes, callback) {
      if (disposed) {
        callback();
      } else if (!snapshotWriteFinished) {
        outputPipeline.push(bytes, () => {
          snapshotWriteFinished = true;
          callback();
          flushPendingWrites();
        });
      } else if (authoritativeGridAvailable) {
        outputPipeline.push(bytes, callback);
      } else {
        pendingWrites.push({ bytes, callback });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const write of pendingWrites.splice(0)) write.callback();
      document.removeEventListener("focusin", refreshVisibility);
      document.removeEventListener("focusout", refreshVisibility);
      window.removeEventListener("resize", updateSurfaceScale);
      resizeObserver.disconnect();
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
      detachPointerCoordinates();
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
      container.style.containerType = previousContainerType;
    },
  };
}
