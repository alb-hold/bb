import type { Terminal as XTermTerminal } from "@xterm/xterm";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";

export const TERMINAL_REPLAY_PREVIEW_FALLBACK_MS = 1_500;

export function mountTerminalReplayPreview({
  container,
  initialFitGrid,
  canShowMismatchedFallback,
  terminal,
}: {
  container: HTMLDivElement;
  initialFitGrid: { cols: number; rows: number };
  canShowMismatchedFallback: () => boolean;
  terminal: XTermTerminal;
}): {
  dispose(): void;
  resize(cols: number, rows: number): void;
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
  const outputPipeline = createTerminalOutputPipeline({
    resize: () => undefined,
    write: (bytes, callback) => terminal.write(bytes, callback),
  });

  let disposed = false;
  let fitGrid = initialFitGrid;
  let fallbackElapsed = false;
  const updateVisibility = () => {
    const matchesFit =
      terminal.cols === fitGrid.cols && terminal.rows === fitGrid.rows;
    const canShowFallback = fallbackElapsed && canShowMismatchedFallback();
    if (canShowFallback && !matchesFit) {
      terminal.resize(fitGrid.cols, fitGrid.rows);
      preview.dataset.gridCols = String(fitGrid.cols);
      preview.dataset.gridRows = String(fitGrid.rows);
    }
    preview.style.visibility =
      matchesFit || canShowFallback ? "visible" : "hidden";
  };
  const refreshVisibility = () => updateVisibility();
  document.addEventListener("focusin", refreshVisibility);
  document.addEventListener("focusout", refreshVisibility);
  window.addEventListener("focus", refreshVisibility);
  window.addEventListener("blur", refreshVisibility);
  const fallbackTimeout = setTimeout(() => {
    fallbackElapsed = true;
    updateVisibility();
  }, TERMINAL_REPLAY_PREVIEW_FALLBACK_MS);
  updateVisibility();
  return {
    resize(cols, rows) {
      if (disposed) return;
      terminal.resize(cols, rows);
      preview.dataset.gridCols = String(cols);
      preview.dataset.gridRows = String(rows);
      updateVisibility();
    },
    setFitGrid(cols, rows) {
      if (disposed) return;
      fitGrid = { cols, rows };
      updateVisibility();
    },
    push(bytes, callback) {
      if (!disposed) outputPipeline.push(bytes, callback);
      else callback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(fallbackTimeout);
      document.removeEventListener("focusin", refreshVisibility);
      document.removeEventListener("focusout", refreshVisibility);
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
    },
  };
}
