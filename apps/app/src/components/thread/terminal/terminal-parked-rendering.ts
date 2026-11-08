import type { Terminal } from "@xterm/xterm";

export function releaseParkedTerminalRendering(terminal: Terminal): void {
  terminal.clearTextureAtlas();
  const fontFamily = terminal.options.fontFamily;
  terminal.options.fontFamily = `${fontFamily} `;
  terminal.options.fontFamily = fontFamily;
  for (const row of terminal.element?.querySelectorAll(".xterm-rows > div") ?? []) {
    row.replaceChildren();
  }
}
