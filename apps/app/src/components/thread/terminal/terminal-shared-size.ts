export interface TerminalGridSize {
  cols: number;
  rows: number;
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
