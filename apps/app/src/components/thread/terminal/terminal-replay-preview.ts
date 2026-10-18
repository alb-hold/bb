import type { Terminal as XTermTerminal } from "@xterm/xterm";

export function mountTerminalReplayPreview({
  container,
  terminal,
}: {
  container: HTMLDivElement;
  terminal: XTermTerminal;
}): { dispose(): void; resize(cols: number, rows: number): void } {
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

  let disposed = false;
  return {
    resize(cols, rows) {
      if (disposed) return;
      terminal.resize(cols, rows);
      preview.dataset.gridCols = String(cols);
      preview.dataset.gridRows = String(rows);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
    },
  };
}
