import type { IDisposable } from "@xterm/xterm";

interface RenderingTerminal {
  readonly rows: number;
  refresh: (start: number, end: number) => void;
  onRender: (listener: () => void) => IDisposable;
}

const PAINT_PENDING = "terminalPaintPending";
const REVEAL_FALLBACK_MS = 400;

export function holdTerminalPaint(root: HTMLElement): void {
  root.dataset[PAINT_PENDING] = "true";
}

export function isTerminalPaintHeld(root: HTMLElement): boolean {
  return root.dataset[PAINT_PENDING] === "true";
}

export function revealTerminalAfterRender(
  terminal: RenderingTerminal,
  root: HTMLElement,
  fallbackMs: number = REVEAL_FALLBACK_MS,
): IDisposable {
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    subscription.dispose();
    delete root.dataset[PAINT_PENDING];
  };
  const subscription = terminal.onRender(release);
  const timer = setTimeout(release, fallbackMs);
  terminal.refresh(0, terminal.rows - 1);
  return { dispose: release };
}
