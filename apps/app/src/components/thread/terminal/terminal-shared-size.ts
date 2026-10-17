export interface TerminalGridSize {
  cols: number;
  rows: number;
}

export function terminalDisplaySize(
  fitted: TerminalGridSize,
  shared: TerminalGridSize | null,
): TerminalGridSize {
  return shared ?? fitted;
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
