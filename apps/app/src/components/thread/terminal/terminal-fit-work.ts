import type { Terminal } from "@xterm/xterm";

interface FitState {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  ptyCols: number;
  ptyRows: number;
  fontFamily: string | undefined;
  fontSize: number | undefined;
  fontWeight: string | number | undefined;
  lineHeight: number | undefined;
  letterSpacing: number | undefined;
  scrollbarWidth: number | undefined;
  scrollbarVisible: boolean | undefined;
  scrollback: number | undefined;
  dpr: number;
  layoutSettled: boolean;
  rendererSettled: boolean;
  retainedOutputReplayed: boolean;
}

type FitTerminal = Pick<Terminal, "cols" | "rows" | "dimensions" | "options">;

export function createTerminalFitWork() {
  let previous: FitState | null = null;
  return {
    invalidate() {
      previous = null;
    },
    run({
      container,
      terminal,
      ptyGrid,
      layoutSettled,
      rendererSettled,
      retainedOutputReplayed,
      work,
    }: {
      container: HTMLElement;
      terminal: FitTerminal;
      ptyGrid: { cols: number; rows: number };
      layoutSettled: boolean;
      rendererSettled: boolean;
      retainedOutputReplayed: boolean;
      work: () => boolean;
    }): void {
      const cell = terminal.dimensions?.css.cell;
      if (!cell || cell.width <= 0 || cell.height <= 0) {
        work();
        return;
      }
      const state: FitState = {
        width: container.clientWidth,
        height: container.clientHeight,
        cellWidth: cell.width,
        cellHeight: cell.height,
        cols: terminal.cols,
        rows: terminal.rows,
        ptyCols: ptyGrid.cols,
        ptyRows: ptyGrid.rows,
        fontFamily: terminal.options.fontFamily,
        fontSize: terminal.options.fontSize,
        fontWeight: terminal.options.fontWeight,
        lineHeight: terminal.options.lineHeight,
        letterSpacing: terminal.options.letterSpacing,
        scrollbarWidth: terminal.options.scrollbar?.width,
        scrollbarVisible: terminal.options.scrollbar?.showScrollbar,
        scrollback: terminal.options.scrollback,
        dpr: window.devicePixelRatio,
        layoutSettled,
        rendererSettled,
        retainedOutputReplayed,
      };
      if (
        previous !== null &&
        state.width === previous.width &&
        state.height === previous.height &&
        state.cellWidth === previous.cellWidth &&
        state.cellHeight === previous.cellHeight &&
        state.cols === previous.cols &&
        state.rows === previous.rows &&
        state.ptyCols === previous.ptyCols &&
        state.ptyRows === previous.ptyRows &&
        state.fontFamily === previous.fontFamily &&
        state.fontSize === previous.fontSize &&
        state.fontWeight === previous.fontWeight &&
        state.lineHeight === previous.lineHeight &&
        state.letterSpacing === previous.letterSpacing &&
        state.scrollbarWidth === previous.scrollbarWidth &&
        state.scrollbarVisible === previous.scrollbarVisible &&
        state.scrollback === previous.scrollback &&
        state.dpr === previous.dpr &&
        state.layoutSettled === previous.layoutSettled &&
        state.rendererSettled === previous.rendererSettled &&
        state.retainedOutputReplayed === previous.retainedOutputReplayed
      )
        return;
      if (work()) previous = state;
    },
  };
}
