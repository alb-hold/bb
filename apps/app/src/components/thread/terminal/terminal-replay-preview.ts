import type { Terminal as XTermTerminal } from "@xterm/xterm";

export function mountTerminalReplayPreview({
  container,
  initialFitGrid,
  sourceTerminal,
  terminal,
}: {
  container: HTMLDivElement;
  initialFitGrid: { cols: number; rows: number };
  sourceTerminal: XTermTerminal;
  terminal: XTermTerminal;
}): {
  dispose(): void;
  matchesFitGrid(): boolean;
  refresh(): void;
  resize(cols: number, rows: number): void;
  setFitGrid(cols: number, rows: number): void;
} {
  const parent = container.parentElement;
  if (!parent) throw new Error("Terminal replay preview requires a parent");

  const previousOpacity = container.style.opacity;
  const preview = document.createElement("div");
  preview.dataset.terminalReplayPreview = "";
  preview.dataset.gridCols = String(terminal.cols);
  preview.dataset.gridRows = String(terminal.rows);
  preview.dataset.fitCols = String(initialFitGrid.cols);
  preview.dataset.fitRows = String(initialFitGrid.rows);
  Object.assign(preview.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    paddingLeft: "0.5rem",
    pointerEvents: "none",
    zIndex: "5",
    visibility: "hidden",
  });
  container.style.opacity = "0";
  parent.append(preview);
  terminal.open(preview);

  let disposed = false;
  let fitGrid = initialFitGrid;
  let currentGrid = { cols: terminal.cols, rows: terminal.rows };
  let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;
  let refreshFrame: number | null = null;
  let snapshotWriting = false;
  let snapshotDirty = false;
  let allowSnapshotVisibility = false;
  let hasShownSnapshot = false;
  const writeSnapshot = () => {
    if (snapshotWriting) {
      snapshotDirty = true;
      return;
    }
    snapshotWriting = true;
    const lines = sourceTerminal.buffer.active;
    const snapshot = Array.from(
      { length: sourceTerminal.rows },
      (_, index) =>
        lines.getLine(lines.viewportY + index)?.translateToString(true) ?? "",
    ).join("\r\n");
    terminal.resize(fitGrid.cols, fitGrid.rows);
    terminal.reset();
    preview.dataset.gridCols = String(terminal.cols);
    preview.dataset.gridRows = String(terminal.rows);
    preview.dataset.fitCols = String(fitGrid.cols);
    preview.dataset.fitRows = String(fitGrid.rows);
    preview.dataset.previewMode = "snapshot";
    terminal.write(snapshot, () => {
      terminal.scrollToBottom();
      preview.dataset.gridCols = String(terminal.cols);
      preview.dataset.gridRows = String(terminal.rows);
      snapshotWriting = false;
      if (snapshotDirty) {
        snapshotDirty = false;
        writeSnapshot();
        return;
      }
      if (allowSnapshotVisibility) {
        hasShownSnapshot = true;
        preview.style.visibility = "visible";
      }
    });
  };
  const updateVisibility = () => {
    if (disposed) return;
    const currentGridMatchesFit =
      currentGrid.cols === fitGrid.cols && currentGrid.rows === fitGrid.rows;
    const sourceGridMatchesFit =
      sourceTerminal.cols === fitGrid.cols &&
      sourceTerminal.rows === fitGrid.rows;
    if (currentGridMatchesFit) {
      if (fallbackTimeout !== null) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      allowSnapshotVisibility = true;
      if (sourceGridMatchesFit) {
        writeSnapshot();
      } else {
        hasShownSnapshot = true;
        preview.style.visibility = "visible";
      }
      return;
    }
    if (hasShownSnapshot) {
      allowSnapshotVisibility = true;
      writeSnapshot();
      return;
    }
    allowSnapshotVisibility = false;
    preview.style.visibility = "hidden";
    if (fallbackTimeout === null) {
      fallbackTimeout = setTimeout(() => {
        fallbackTimeout = null;
        if (
          !disposed &&
          (currentGrid.cols !== fitGrid.cols ||
            currentGrid.rows !== fitGrid.rows)
        ) {
          allowSnapshotVisibility = true;
          writeSnapshot();
        }
      }, 1500);
    }
  };
  updateVisibility();
  return {
    matchesFitGrid() {
      return (
        currentGrid.cols === fitGrid.cols &&
        currentGrid.rows === fitGrid.rows &&
        sourceTerminal.cols === fitGrid.cols &&
        sourceTerminal.rows === fitGrid.rows
      );
    },
    refresh() {
      if (disposed) return;
      if (
        currentGrid.cols === fitGrid.cols &&
        currentGrid.rows === fitGrid.rows &&
        sourceTerminal.cols === fitGrid.cols &&
        sourceTerminal.rows === fitGrid.rows
      ) {
        if (fallbackTimeout !== null) {
          clearTimeout(fallbackTimeout);
          fallbackTimeout = null;
        }
        allowSnapshotVisibility = true;
        if (preview.style.visibility !== "visible") {
          writeSnapshot();
          return;
        }
      }
      if (preview.style.visibility !== "visible") return;
      if (refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        if (!disposed && preview.style.visibility === "visible") {
          writeSnapshot();
        }
      });
    },
    resize(cols, rows) {
      if (disposed) return;
      currentGrid = { cols, rows };
      updateVisibility();
    },
    setFitGrid(cols, rows) {
      if (disposed) return;
      if (fitGrid.cols !== cols || fitGrid.rows !== rows) {
        preview.style.visibility = "hidden";
      }
      fitGrid = { cols, rows };
      terminal.resize(cols, rows);
      preview.dataset.gridCols = String(terminal.cols);
      preview.dataset.gridRows = String(terminal.rows);
      preview.dataset.fitCols = String(cols);
      preview.dataset.fitRows = String(rows);
      updateVisibility();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (fallbackTimeout !== null) clearTimeout(fallbackTimeout);
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
    },
  };
}
