import type { Terminal } from "@xterm/xterm";

export function trackTerminalScrollability(
  terminal: Pick<Terminal, "element" | "buffer" | "onRender" | "onScroll">,
): void {
  const update = () => {
    if (terminal.element)
      terminal.element.dataset.scrollable = String(
        terminal.buffer.active.baseY > 0,
      );
  };
  terminal.onRender(update);
  terminal.onScroll(update);
  update();
}
