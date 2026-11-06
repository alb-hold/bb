import { trackTerminalScrollability } from "./terminal-scrollbar";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { TerminalGrid } from "@bb/domain";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import { canRevealTerminalSurface } from "./terminal-grid-presentation";

export const TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS = 5_000;

export function createTerminalReplayPreviewExitHandler({
  getReplayState,
  isApplied,
  isPending,
  markApplied,
  markPending,
  releasePreview,
  processExited,
}: {
  getReplayState: () => {
    hasReplaySurface: boolean;
    replayCompleted: boolean;
  };
  isApplied: () => boolean;
  isPending: () => boolean;
  markApplied: () => void;
  markPending: () => void;
  releasePreview: () => void;
  processExited: () => void;
}): () => void {
  return () => {
    if (isApplied() || isPending()) return;
    const state = getReplayState();
    if (state.hasReplaySurface && !state.replayCompleted) {
      markPending();
      return;
    }
    markApplied();
    releasePreview();
    processExited();
  };
}

export function completeTerminalReplayPreview({
  hasPendingExit,
  markExitApplied,
  clearPendingExit,
  releasePreview,
  processExited,
}: {
  hasPendingExit: boolean;
  markExitApplied: () => void;
  clearPendingExit: () => void;
  releasePreview: () => void;
  processExited: () => void;
}): void {
  if (!hasPendingExit) {
    releasePreview();
    return;
  }
  clearPendingExit();
  markExitApplied();
  processExited();
}

export function resetTerminalExitNoticeForSession({
  lastNotice,
  lastSessionId,
  sessionId,
}: {
  lastNotice: { current: string | null };
  lastSessionId: { current: string };
  sessionId: string;
}): void {
  if (lastSessionId.current === sessionId) return;
  lastSessionId.current = sessionId;
  lastNotice.current = null;
}

export function createTerminalExitNoticeHandler({
  getReplayState,
  getLastStatusNotice,
  setLastStatusNotice,
  pushReplay,
  queueNotice,
  restoreTerminalHistory,
  writeTerminal,
}: {
  getLastStatusNotice: () => string | null;
  setLastStatusNotice: (status: "exited") => void;
  getReplayState: () => {
    hasReplaySurface: boolean;
    replayStarted: boolean;
    replayCompleted: boolean;
    needsHistoryRestore: boolean;
  };
  pushReplay: (bytes: Uint8Array) => void;
  queueNotice: (text: string) => void;
  restoreTerminalHistory: () => Promise<void>;
  writeTerminal: (text: string) => void;
}): (text: string) => boolean {
  return (text) => {
    if (getLastStatusNotice() === "exited") return true;
    setLastStatusNotice("exited");
    const state = getReplayState();
    routeTerminalExitNotice({
      hasReplaySurface: () => state.hasReplaySurface,
      isReplayStarted: () => state.replayStarted,
      isReplayComplete: () => state.replayCompleted,
      needsHistoryRestore: () => state.needsHistoryRestore,
      restoreTerminalHistory,
      pushReplay,
      queueNotice,
      text,
      writeTerminal,
    });
    return true;
  };
}

export function routeTerminalExitNotice({
  hasReplaySurface,
  isReplayStarted,
  isReplayComplete,
  needsHistoryRestore,
  restoreTerminalHistory,
  pushReplay,
  queueNotice,
  text,
  writeTerminal,
}: {
  hasReplaySurface: () => boolean;
  isReplayStarted: () => boolean;
  isReplayComplete: () => boolean;
  needsHistoryRestore: () => boolean;
  restoreTerminalHistory: () => Promise<void>;
  pushReplay: (bytes: Uint8Array) => void;
  queueNotice: (text: string) => void;
  text: string;
  writeTerminal: (text: string) => void;
}): void {
  if (isReplayComplete() && needsHistoryRestore()) {
    void restoreTerminalHistory()
      .catch(() => undefined)
      .then(() => writeTerminal(text));
    return;
  }
  if (hasReplaySurface() && !isReplayComplete()) {
    pushReplay(new TextEncoder().encode(`\r\n\x1b[2m${text}\x1b[0m\r\n`));
    queueNotice(text);
    return;
  }
  if (!isReplayStarted() && !isReplayComplete()) {
    queueNotice(text);
    return;
  }
  writeTerminal(text);
}

export function updateTerminalReplayPreviewPtyGrid(
  preview: {
    setLatestPtyGrid(cols: number, rows: number): void;
    setPtyGrid(cols: number, rows: number): void;
  } | null,
  grid: TerminalGrid,
  apply: boolean,
): void {
  if (apply) preview?.setPtyGrid(grid.cols, grid.rows);
  else preview?.setLatestPtyGrid(grid.cols, grid.rows);
}

export function mountTerminalReplayPreview({
  container,
  holdUntilReleased = false,
  initialFitGrid,
  isOwner,
  onHoldExpired,
  liveTerminal,
  paddingLeft = getComputedStyle(container).paddingLeft,
  readyToPaint = () => true,
  terminal,
}: {
  container: HTMLDivElement;
  holdUntilReleased?: boolean;
  initialFitGrid: { cols: number; rows: number } | null;
  isOwner: () => boolean;
  onHoldExpired?: () => void;
  liveTerminal?: XTermTerminal;
  paddingLeft?: string;
  readyToPaint?: () => boolean;
  terminal: XTermTerminal;
}): {
  readonly fallback: boolean;
  dispose(): void;
  release(): void;
  showFallback(): void;
  hold(options: { countdown: boolean }): void;
  noteProgress(): void;
  refreshFonts(): void;
  resize(cols: number, rows: number): Promise<void>;
  setPtyGrid(cols: number, rows: number): void;
  setLatestPtyGrid(cols: number, rows: number): void;
  setFitGrid(cols: number, rows: number): void;
  processExited(): void;
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
  if (holdUntilReleased) preview.dataset.terminalReplayHeld = "";
  Object.assign(preview.style, {
    visibility: holdUntilReleased ? "hidden" : "",
    position: "absolute",
    boxSizing: "border-box",
    overflow: "hidden",
    overflowX: "hidden",
    paddingLeft,
    pointerEvents: "none",
    zIndex: "5",
    containerType: "inline-size",
  });
  container.style.opacity = "0";
  parent.append(preview);
  terminal.options.disableStdin = true;
  if (liveTerminal) {
    terminal.options.fontFamily = liveTerminal.options.fontFamily;
    terminal.options.fontSize = liveTerminal.options.fontSize;
    terminal.options.lineHeight = liveTerminal.options.lineHeight;
  }
  terminal.open(preview);
  trackTerminalScrollability(terminal);
  if (terminal.element) terminal.element.style.pointerEvents = "none";
  if (terminal.textarea) terminal.textarea.tabIndex = -1;
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
  let held = holdUntilReleased;
  let holdCountdown = holdUntilReleased;
  let holdTimeout: number | null = null;
  let snapshotWriteFinished = false;
  let authoritativeGridAvailable = false;
  let handoffRequested = false;
  let pendingWrites: Array<{ bytes: Uint8Array; callback: () => void }> = [];
  let pendingBytes = 0;
  let handoffDeadline: number | null = null;
  const pendingBytesLimit = 256 * 1024;
  let cellWidth = 0;
  const originalSpacing = new WeakMap<
    HTMLElement,
    { source: string; applied: string; cellsPerCharacter: number }
  >();
  const matchCellWidth = () => {
    if (held || !readyToPaint()) return;
    const dimensions = terminal.dimensions;
    const screen =
      terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const rows = terminal.element?.querySelector<HTMLElement>(".xterm-rows");
    if (
      !screen ||
      !rows ||
      !dimensions ||
      dimensions.css.cell.width <= 0 ||
      cellWidth <= 0
    )
      return;
    const residual = cellWidth - dimensions.css.cell.width;
    const elements = [
      rows,
      ...rows.querySelectorAll<HTMLElement>("span[style*='letter-spacing']"),
    ];
    const spacing = elements.map((element) => {
      const previous = originalSpacing.get(element);
      const unchanged = element.style.letterSpacing === previous?.applied;
      const source = unchanged ? previous.source : element.style.letterSpacing;
      const cellsPerCharacter = unchanged
        ? previous.cellsPerCharacter
        : element === rows
          ? 1
          : element.getBoundingClientRect().width /
            dimensions.css.cell.width /
            Math.max(1, Array.from(element.textContent ?? "").length);
      return { element, source, cellsPerCharacter };
    });
    for (const { element, source, cellsPerCharacter } of spacing) {
      const applied = `${(parseFloat(source) || 0) + residual * cellsPerCharacter}px`;
      element.style.letterSpacing = applied;
      originalSpacing.set(element, {
        source,
        applied: element.style.letterSpacing,
        cellsPerCharacter,
      });
    }
    screen.style.width = `${cellWidth * terminal.cols}px`;
    for (const row of rows.children) {
      if (row instanceof HTMLElement)
        row.style.width = `${cellWidth * terminal.cols}px`;
    }
  };
  const updateSurfaceLayout = () => {
    preview.style.top = `${container.offsetTop}px`;
    preview.style.left = `${container.offsetLeft}px`;
    preview.style.width = `${container.clientWidth}px`;
    preview.style.height = `${container.clientHeight}px`;
    if (liveTerminal) {
      terminal.options.fontFamily = liveTerminal.options.fontFamily;
      terminal.options.fontSize = liveTerminal.options.fontSize;
      terminal.options.lineHeight = liveTerminal.options.lineHeight;
      if (readyToPaint()) {
        const liveScreen =
          liveTerminal.element?.querySelector<HTMLElement>(".xterm-screen");
        cellWidth =
          (liveScreen?.getBoundingClientRect().width ?? 0) / liveTerminal.cols;
        const dimensions = terminal.dimensions;
        if (cellWidth > 0 && dimensions) {
          const dpr = window.devicePixelRatio || 1;
          const unspacedWidth =
            dimensions.css.cell.width -
            Math.round(terminal.options.letterSpacing ?? 0) / dpr;
          terminal.options.letterSpacing = (cellWidth - unspacedWidth) * dpr;
          matchCellWidth();
        }
      }
    }
    if (terminal.element) {
      terminal.element.style.transform = "none";
      const screenHeight =
        terminal.element
          .querySelector<HTMLElement>(".xterm-screen")
          ?.getBoundingClientRect().height ?? 0;
      const cellHeight = screenHeight / terminal.rows;
      const top =
        cellHeight > 0
          ? Math.min(
              0,
              Math.floor(container.clientHeight / cellHeight) - terminal.rows,
            ) * cellHeight
          : 0;
      terminal.element.style.position = "relative";
      terminal.element.style.top = `${top}px`;
    }
  };
  updateSurfaceLayout();
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
  const renderSubscription = terminal.onRender(matchCellWidth);
  const resizeObserver = new ResizeObserver(updateVisibility);
  resizeObserver.observe(container);
  window.addEventListener("resize", updateVisibility);
  function updateVisibility() {
    updateSurfaceLayout();
    if (held || !readyToPaint()) {
      preview.style.visibility = "hidden";
      return;
    }
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
  }
  const refreshVisibility = () => updateVisibility();
  const flushPendingWrites = () => {
    if (disposed || !snapshotWriteFinished || !authoritativeGridAvailable) {
      return;
    }
    const writes = pendingWrites.splice(0);
    pendingBytes = 0;
    for (const write of writes) {
      outputPipeline.push(write.bytes, write.callback);
    }
  };
  const clearHandoffDeadline = () => {
    if (handoffDeadline !== null) {
      window.clearTimeout(handoffDeadline);
      handoffDeadline = null;
    }
  };
  const handoffAtLatestGrid = () => {
    if (disposed || authoritativeGridAvailable || handoffRequested) return;
    handoffRequested = true;
    clearHandoffDeadline();
    const handoffGrid = {
      cols: latestPtyGrid.cols,
      rows: Math.max(latestPtyGrid.rows, terminal.rows),
    };
    outputPipeline.setGrid(handoffGrid.cols, handoffGrid.rows, () => {
      if (disposed) return;
      preview.dataset.gridCols = String(handoffGrid.cols);
      preview.dataset.gridRows = String(handoffGrid.rows);
      authoritativeGridAvailable = true;
      updateVisibility();
      flushPendingWrites();
    });
  };
  const startHandoffDeadline = () => {
    if (
      disposed ||
      authoritativeGridAvailable ||
      handoffRequested ||
      handoffDeadline !== null
    ) {
      return;
    }
    handoffDeadline = window.setTimeout(handoffAtLatestGrid, 500);
  };
  document.addEventListener("focusin", refreshVisibility);
  document.addEventListener("focusout", refreshVisibility);
  window.addEventListener("focus", refreshVisibility);
  window.addEventListener("blur", refreshVisibility);
  if (readyToPaint() && fitGrid !== null && fitGrid.rows > terminal.rows) {
    terminal.resize(snapshotGrid.cols, fitGrid.rows);
  }
  updateVisibility();
  const setPtyGrid = (cols: number, rows: number) => {
    if (disposed) return;
    clearHandoffDeadline();
    latestPtyGrid = { cols, rows };
    authoritativeGridAvailable = true;
    updateVisibility();
    flushPendingWrites();
  };
  const clearHoldTimeout = () => {
    if (holdTimeout === null) return;
    window.clearTimeout(holdTimeout);
    holdTimeout = null;
  };
  const release = () => {
    clearHoldTimeout();
    if (disposed || !held) return;
    held = false;
    delete preview.dataset.terminalReplayHeld;
    delete preview.dataset.terminalReplayHoldExpired;
    updateVisibility();
  };
  const showFallback = () => {
    if (disposed) return;
    preview.style.visibility = "hidden";
    container.style.opacity = previousOpacity;
  };
  const armHoldTimeout = () => {
    clearHoldTimeout();
    holdTimeout = window.setTimeout(
      expireHold,
      TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS,
    );
  };
  const expireHold = () => {
    if (disposed || !held) return;
    holdTimeout = null;
    preview.dataset.terminalReplayHoldExpired = "";
    onHoldExpired?.();
  };
  const noteProgress = () => {
    if (!disposed && held && holdCountdown) armHoldTimeout();
  };
  if (held) armHoldTimeout();
  return {
    fallback: holdUntilReleased,
    release,
    showFallback,
    hold({ countdown }) {
      if (disposed) return;
      held = true;
      holdCountdown = countdown;
      preview.dataset.terminalReplayHeld = "";
      delete preview.dataset.terminalReplayHoldExpired;
      if (countdown) armHoldTimeout();
      else clearHoldTimeout();
      updateVisibility();
    },
    noteProgress,
    refreshFonts() {
      const family = terminal.options.fontFamily;
      terminal.options.fontFamily = `${family} `;
      terminal.options.fontFamily = family;
      updateVisibility();
    },
    resize(cols, rows) {
      if (disposed) return Promise.resolve();
      clearHandoffDeadline();
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
    setLatestPtyGrid(cols, rows) {
      if (disposed) return;
      latestPtyGrid = { cols, rows };
    },
    setFitGrid(cols, rows) {
      if (disposed) return;
      fitGrid = { cols, rows };
      if (
        readyToPaint() &&
        terminal.cols === snapshotGrid.cols &&
        rows > terminal.rows
      ) {
        terminal.resize(snapshotGrid.cols, rows);
      }
      updateVisibility();
    },
    processExited() {
      handoffAtLatestGrid();
    },
    push(bytes, callback) {
      noteProgress();
      const onParsed = () => {
        noteProgress();
        callback();
      };
      if (disposed) {
        callback();
      } else if (!snapshotWriteFinished) {
        outputPipeline.push(bytes, () => {
          snapshotWriteFinished = true;
          startHandoffDeadline();
          onParsed();
          flushPendingWrites();
        });
      } else if (authoritativeGridAvailable) {
        outputPipeline.push(bytes, onParsed);
      } else {
        pendingWrites.push({ bytes, callback: onParsed });
        pendingBytes += bytes.byteLength;
        if (pendingBytes > pendingBytesLimit) handoffAtLatestGrid();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearHoldTimeout();
      clearHandoffDeadline();
      for (const write of pendingWrites.splice(0)) write.callback();
      pendingBytes = 0;
      document.removeEventListener("focusin", refreshVisibility);
      document.removeEventListener("focusout", refreshVisibility);
      window.removeEventListener("resize", updateVisibility);
      resizeObserver.disconnect();
      renderSubscription.dispose();
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
      terminal.dispose();
      preview.remove();
      container.style.opacity = previousOpacity;
      container.style.containerType = previousContainerType;
    },
  };
}
