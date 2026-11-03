export interface BuildTerminalWebSocketPathArgs {
  handoffOwnerToken?: string | null;
  terminalId: string;
}

export function buildTerminalWebSocketPath({
  handoffOwnerToken,
  terminalId,
}: BuildTerminalWebSocketPathArgs): string {
  const query =
    handoffOwnerToken == null
      ? ""
      : `?handoffOwnerToken=${encodeURIComponent(handoffOwnerToken)}`;
  return `/ws/terminals/${encodeURIComponent(terminalId)}${query}`;
}
