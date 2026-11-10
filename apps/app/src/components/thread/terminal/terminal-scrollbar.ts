import type { Terminal } from "@xterm/xterm";

export function trackTerminalScrollability(
  terminal: Pick<Terminal, "element" | "buffer" | "onRender" | "onScroll">,
): void {
  const update = () => {
    const element = terminal.element;
    if (element === undefined) return;
    const scrollable = String(terminal.buffer.active.baseY > 0);
    if (element.dataset.scrollable !== scrollable)
      element.dataset.scrollable = scrollable;
  };
  terminal.onRender(update);
  terminal.onScroll(update);
  update();
}
