import { useEffect, useSyncExternalStore } from "react";

let activeView: { ownerId: string; terminalId: string } | null = null;
const listeners = new Set<() => void>();

export function setActiveDeviceHandoffTerminal(
  ownerId: string,
  terminalId: string | null,
): void {
  if (terminalId === null) {
    if (activeView?.ownerId !== ownerId) return;
    activeView = null;
  } else {
    if (
      activeView?.ownerId === ownerId &&
      activeView.terminalId === terminalId
    ) {
      return;
    }
    activeView = { ownerId, terminalId };
  }
  for (const listener of listeners) listener();
}

export function useActiveDeviceHandoffTerminal(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activeView?.terminalId ?? null,
    () => null,
  );
}

export function useActiveDeviceHandoffTerminalView(args: {
  ownerId: string;
  terminalId: string | null;
  isFocused: boolean;
  isOpen: boolean;
}): void {
  const { isFocused, isOpen, ownerId, terminalId } = args;
  useEffect(() => {
    if (!isFocused) return;
    setActiveDeviceHandoffTerminal(ownerId, isOpen ? terminalId : null);
    return () => setActiveDeviceHandoffTerminal(ownerId, null);
  }, [isFocused, isOpen, ownerId, terminalId]);
}
