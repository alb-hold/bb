import type { Terminal as XTermTerminal } from "@xterm/xterm";

export function sendTerminalTapClick(
  terminal: Pick<XTermTerminal, "element" | "modes">,
  point: { x: number; y: number },
): boolean {
  if (terminal.modes.mouseTrackingMode === "none") {
    return false;
  }
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement)) {
    return false;
  }
  const rect = screen.getBoundingClientRect();
  if (
    point.x < rect.left ||
    point.x >= rect.right ||
    point.y < rect.top ||
    point.y >= rect.bottom
  ) {
    return false;
  }
  const init = {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  };
  screen.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  screen.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  return true;
}
