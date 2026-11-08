import type { Terminal } from "@xterm/xterm";

export function releaseParkedTerminalRendering(terminal: Terminal): void {
  terminal.clearTextureAtlas();
  for (const row of terminal.element?.querySelectorAll(".xterm-rows > div") ?? []) {
    row.replaceChildren();
  }
}
