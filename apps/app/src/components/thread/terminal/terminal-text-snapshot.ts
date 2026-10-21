import type { Terminal as XTermTerminal } from "@xterm/xterm";

export const TERMINAL_TEXT_SNAPSHOT_MAX_LINES = 5_000;

export function terminalTextSnapshot(
  terminal: Pick<XTermTerminal, "buffer">,
  maxLines = TERMINAL_TEXT_SNAPSHOT_MAX_LINES,
): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const start = Math.max(0, buffer.length - maxLines);
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line === undefined) {
      continue;
    }
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

export function terminalTextSnapshotLineIndex(
  terminal: Pick<XTermTerminal, "buffer">,
  bufferLine: number,
  maxLines = TERMINAL_TEXT_SNAPSHOT_MAX_LINES,
): number {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const target = Math.min(Math.max(bufferLine, start), buffer.length - 1);
  let snapshotLine = -1;
  let previousBufferLine = -1;
  for (let index = start; index <= target; index += 1) {
    const line = buffer.getLine(index);
    if (line === undefined) continue;
    if (!line.isWrapped || snapshotLine < 0) snapshotLine += 1;
    previousBufferLine = index;
  }
  return previousBufferLine < 0 ? 0 : snapshotLine;
}
