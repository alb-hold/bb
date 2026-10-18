import { useSyncExternalStore } from "react";

let activeTerminalId: string | null = null;
const listeners = new Set<() => void>();

export function setActiveDeviceHandoffTerminal(
  terminalId: string | null,
): void {
  if (activeTerminalId === terminalId) return;
  activeTerminalId = terminalId;
  for (const listener of listeners) listener();
}

export function useActiveDeviceHandoffTerminal(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activeTerminalId,
    () => null,
  );
}
