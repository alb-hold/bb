import type { Terminal as XTermTerminal } from "@xterm/xterm";

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export interface TerminalWheelLineState {
  remainderPx: number;
}

export function terminalWheelLines(
  state: TerminalWheelLineState,
  event: Pick<WheelEvent, "deltaMode" | "deltaY">,
  cellHeightPx: number,
  rows: number,
): number {
  if (event.deltaY === 0) {
    return 0;
  }
  if (event.deltaMode === DOM_DELTA_LINE) {
    state.remainderPx = 0;
    return clampLines(Math.trunc(event.deltaY), rows);
  }
  if (event.deltaMode === DOM_DELTA_PAGE) {
    state.remainderPx = 0;
    return clampLines(Math.trunc(event.deltaY * rows), rows);
  }
  if (!(cellHeightPx > 0)) {
    return 0;
  }
  if (Math.sign(state.remainderPx) === -Math.sign(event.deltaY)) {
    state.remainderPx = 0;
  }
  state.remainderPx += event.deltaY;
  const lines = Math.trunc(state.remainderPx / cellHeightPx);
  state.remainderPx -= lines * cellHeightPx;
  return clampLines(lines, rows);
}

function clampLines(lines: number, rows: number): number {
  const limit = Math.max(1, rows);
  return Math.max(-limit, Math.min(limit, lines)) || 0;
}

function terminalCellHeightPx(
  terminal: Pick<XTermTerminal, "element" | "rows">,
): number {
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement) || terminal.rows <= 0) {
    return 0;
  }
  return screen.getBoundingClientRect().height / terminal.rows;
}

export function attachTerminalWheelLines(
  terminal: Pick<
    XTermTerminal,
    "attachCustomWheelEventHandler" | "element" | "modes" | "rows"
  >,
): void {
  const state: TerminalWheelLineState = { remainderPx: 0 };
  const lineEvents = new WeakSet<WheelEvent>();
  terminal.attachCustomWheelEventHandler((event) => {
    if (
      lineEvents.has(event) ||
      event.shiftKey ||
      terminal.modes.mouseTrackingMode === "none"
    ) {
      return true;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return true;
    }
    const lines = terminalWheelLines(
      state,
      event,
      terminalCellHeightPx(terminal),
      terminal.rows,
    );
    for (let index = 0; index < Math.abs(lines); index += 1) {
      const lineEvent = new WheelEvent("wheel", {
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        deltaMode: DOM_DELTA_LINE,
        deltaY: Math.sign(lines),
        metaKey: event.metaKey,
        screenX: event.screenX,
        screenY: event.screenY,
      });
      lineEvents.add(lineEvent);
      target.dispatchEvent(lineEvent);
    }
    return false;
  });
}
