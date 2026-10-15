export interface TerminalGridSize {
  cols: number;
  rows: number;
}

export function applyTerminalFitDimensions(
  fitted: TerminalGridSize,
  shared: TerminalGridSize | null,
  surfaceVisible: boolean,
  resizeTerminal: (cols: number, rows: number) => void,
  sendPtyResize: (cols: number, rows: number) => void,
): void {
  const display = terminalDisplaySize(fitted, shared);
  if (surfaceVisible) {
    resizeTerminal(display.cols, display.rows);
  }
  sendPtyResize(fitted.cols, fitted.rows);
}

export function terminalDisplaySize(
  fitted: TerminalGridSize,
  shared: TerminalGridSize | null,
): TerminalGridSize {
  if (shared === null) {
    return fitted;
  }
  return {
    cols: Math.min(fitted.cols, shared.cols),
    rows: Math.min(fitted.rows, shared.rows),
  };
}

export function nextSharedTerminalSize(
  current: TerminalGridSize | null,
  reported: TerminalGridSize,
  isOwnRepaintNudgeEcho: boolean,
): TerminalGridSize | null {
  if (isOwnRepaintNudgeEcho) {
    return null;
  }
  if (current?.cols === reported.cols && current.rows === reported.rows) {
    return null;
  }
  return reported;
}
