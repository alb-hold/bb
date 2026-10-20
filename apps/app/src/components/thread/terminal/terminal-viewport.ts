export interface TerminalViewportAnchor {
  distanceFromTail: number;
  outputSequence: number;
}

export interface TerminalViewportStorage
  extends Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> {}

export function terminalViewportStorageKey(terminalId: string): string {
  return `bb:terminal-viewport:${terminalId}`;
}

const terminalViewportStoragePrefix = "bb:terminal-viewport:";
const terminalViewportIndexKey = `${terminalViewportStoragePrefix}index`;
const terminalViewportLimit = 200;

function isTerminalViewportAnchor(value: unknown): value is TerminalViewportAnchor {
  return (
    typeof value === "object" &&
    value !== null &&
    "distanceFromTail" in value &&
    Number.isInteger(value.distanceFromTail) &&
    typeof value.distanceFromTail === "number" &&
    value.distanceFromTail >= 0 &&
    "outputSequence" in value &&
    Number.isInteger(value.outputSequence) &&
    typeof value.outputSequence === "number" &&
    value.outputSequence >= 0
  );
}

function sameAnchor(
  first: TerminalViewportAnchor | null,
  second: TerminalViewportAnchor | null,
): boolean {
  return (
    first === second ||
    (first !== null &&
      second !== null &&
      first.distanceFromTail === second.distanceFromTail &&
      first.outputSequence === second.outputSequence)
  );
}

export function readTerminalViewportAnchor(
  storage: Pick<TerminalViewportStorage, "getItem">,
  key: string,
): TerminalViewportAnchor | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    return isTerminalViewportAnchor(value) ? value : null;
  } catch {
    return null;
  }
}

function readTerminalViewportKeys(storage: TerminalViewportStorage): string[] {
  try {
    const storedKeys: unknown = JSON.parse(
      storage.getItem(terminalViewportIndexKey) ?? "null",
    );
    const keys = Array.isArray(storedKeys)
      ? storedKeys.filter(
          (key): key is string =>
            typeof key === "string" &&
            key.startsWith(terminalViewportStoragePrefix) &&
            key !== terminalViewportIndexKey,
        )
      : [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key !== null &&
        key.startsWith(terminalViewportStoragePrefix) &&
        key !== terminalViewportIndexKey &&
        !keys.includes(key)
      ) {
        keys.push(key);
      }
    }
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

export function writeTerminalViewportAnchor(
  storage: TerminalViewportStorage,
  key: string,
  anchor: TerminalViewportAnchor,
): void {
  try {
    storage.setItem(key, JSON.stringify(anchor));
    const keys = readTerminalViewportKeys(storage).filter(
      (candidate) => candidate !== key,
    );
    keys.push(key);
    while (keys.length > terminalViewportLimit) {
      storage.removeItem(keys.shift() ?? "");
    }
    storage.setItem(terminalViewportIndexKey, JSON.stringify(keys));
  } catch {
    return;
  }
}

export function createTerminalViewportPersistence(args: {
  key: string;
  storage: TerminalViewportStorage;
  delayMs?: number;
}): {
  schedule: (anchor: TerminalViewportAnchor) => void;
  flush: () => void;
  dispose: () => void;
} {
  const { key, storage, delayMs = 250 } = args;
  let persisted = readTerminalViewportAnchor(storage, key);
  let pending: TerminalViewportAnchor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancelTimer();
    if (pending === null) {
      return;
    }
    const next = pending;
    pending = null;
    if (!sameAnchor(next, persisted)) {
      writeTerminalViewportAnchor(storage, key, next);
      persisted = next;
    }
  };

  return {
    schedule: (anchor) => {
      if (sameAnchor(anchor, pending)) {
        return;
      }
      if (sameAnchor(anchor, persisted)) {
        pending = null;
        cancelTimer();
        return;
      }
      pending = anchor;
      cancelTimer();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose: flush,
  };
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
