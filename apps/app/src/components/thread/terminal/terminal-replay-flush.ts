import type { Terminal } from "@xterm/xterm";
import { markTerminalPerformance } from "@/lib/terminal-performance";

export function flushTerminalReplay(terminal: Terminal, surface: string): void {
  const core: unknown = Reflect.get(terminal, "_core");
  if (typeof core !== "object" || core === null) return;
  const buffer: unknown = Reflect.get(core, "_writeBuffer");
  if (typeof buffer !== "object" || buffer === null) return;
  const pending: unknown = Reflect.get(buffer, "_pendingData");
  const flush: unknown = Reflect.get(buffer, "flushSync");
  if (
    typeof pending !== "number" ||
    pending <= 0 ||
    pending > 16 * 1024 ||
    typeof flush !== "function"
  )
    return;
  const start = performance.now();
  markTerminalPerformance(`terminal-replay-${surface}-flush-start`);
  flush.call(buffer);
  markTerminalPerformance(`terminal-replay-${surface}-flush-end`, {
    detail: { bytes: pending, elapsedMs: performance.now() - start },
  });
}
