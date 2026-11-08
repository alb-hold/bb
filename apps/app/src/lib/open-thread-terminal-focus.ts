const handlers = new Map<string, Set<(terminalId: string) => boolean>>();

export function registerOpenThreadTerminalFocus(
  threadId: string,
  select: (terminalId: string) => boolean,
): () => void {
  const callbacks =
    handlers.get(threadId) ?? new Set<(terminalId: string) => boolean>();
  handlers.set(threadId, callbacks);
  callbacks.add(select);
  return () => {
    callbacks.delete(select);
    if (callbacks.size === 0) handlers.delete(threadId);
  };
}

export function focusOpenThreadTerminal(
  threadId: string,
  terminalId: string,
): boolean {
  const callbacks = handlers.get(threadId);
  if (callbacks?.size !== 1) return false;
  for (const select of callbacks) return select(terminalId);
  return false;
}
