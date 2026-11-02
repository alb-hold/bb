export interface TerminalGridSize {
  cols: number;
  rows: number;
}

export interface TerminalGridTarget extends TerminalGridSize {
  refresh: (start: number, end: number) => void;
  resize: (cols: number, rows: number) => void;
}

export interface TerminalGridTransport {
  sendResize: (cols: number, rows: number) => void;
}

export function resizeTerminalGrid(
  terminal: TerminalGridTarget,
  size: TerminalGridSize,
): boolean {
  if (terminal.cols === size.cols && terminal.rows === size.rows) {
    return false;
  }
  terminal.resize(size.cols, size.rows);
  terminal.refresh(0, size.rows - 1);
  return true;
}

export function fitTerminalGrid(
  terminal: TerminalGridTarget,
  fitted: TerminalGridSize,
  shared: TerminalGridSize | null,
  transport: TerminalGridTransport | null,
): void {
  resizeTerminalGrid(terminal, shared ?? fitted);
  transport?.sendResize(fitted.cols, fitted.rows);
}
