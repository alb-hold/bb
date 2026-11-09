import type { Terminal } from "@xterm/xterm";

export function releaseParkedTerminalRendering(terminal: Terminal): () => void {
  const scrollbars = Array.from(
    terminal.element?.querySelectorAll<HTMLElement>(".xterm-scrollbar") ?? [],
    (element) => ({ element, display: element.style.display }),
  );
  for (const { element } of scrollbars) element.style.display = "none";
  terminal.clearTextureAtlas();
  for (const row of terminal.element?.querySelectorAll(".xterm-rows > div") ?? []) {
    row.replaceChildren();
  }
  return () => {
    for (const { element, display } of scrollbars) element.style.display = display;
  };
}
