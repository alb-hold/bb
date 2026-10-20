export interface TerminalViewportAnchor {
  distanceFromTail: number;
  outputSequence: number;
}

export function terminalViewportStorageKey(
  scopeId: string,
  terminalId: string,
): string {
  return `bb:terminal-viewport:${scopeId}:${terminalId}`;
}

export function readTerminalViewportAnchor(
  storage: Pick<Storage, "getItem">,
  key: string,
): TerminalViewportAnchor | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("distanceFromTail" in value) ||
      !("outputSequence" in value) ||
      typeof value.distanceFromTail !== "number" ||
      !Number.isInteger(value.distanceFromTail) ||
      value.distanceFromTail < 0 ||
      typeof value.outputSequence !== "number" ||
      !Number.isInteger(value.outputSequence) ||
      value.outputSequence < 0
    ) {
      return null;
    }
    return {
      distanceFromTail: value.distanceFromTail,
      outputSequence: value.outputSequence,
    };
  } catch {
    return null;
  }
}

export function writeTerminalViewportAnchor(
  storage: Pick<Storage, "setItem">,
  key: string,
  anchor: TerminalViewportAnchor,
): void {
  try {
    storage.setItem(key, JSON.stringify(anchor));
  } catch {
    return;
  }
}

export function resolveTerminalViewportRestore(args: {
  anchor: TerminalViewportAnchor | null;
  baseY: number;
  replayStartSequence: number;
}): number {
  const { anchor, baseY, replayStartSequence } = args;
  if (
    anchor === null ||
    anchor.distanceFromTail === 0 ||
    anchor.distanceFromTail > baseY ||
    anchor.outputSequence < replayStartSequence
  ) {
    return baseY;
  }
  return baseY - anchor.distanceFromTail;
}
