export interface TerminalViewportAnchor {
  distanceFromTail: number;
  lineOffset?: number;
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
    (!("lineOffset" in value) ||
      (typeof value.lineOffset === "number" && Number.isInteger(value.lineOffset))) &&
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
      first.lineOffset === second.lineOffset &&
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

export function createTerminalViewportReplaySaveGate(): {
  beginReplay: () => void;
  finishRestore: () => void;
  canSave: (hasManualScrollIntent: boolean) => boolean;
} {
  let restorePending = true;
  return {
    beginReplay: () => {
      restorePending = true;
    },
    finishRestore: () => {
      restorePending = false;
    },
    canSave: (hasManualScrollIntent) =>
      !restorePending && hasManualScrollIntent,
  };
}

export function createTerminalTouchViewportSaveScheduler(args: {
  getViewportY: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  save: () => void;
}): {
  schedule: () => void;
  dispose: () => void;
} {
  const { getViewportY, requestFrame, cancelFrame, save } = args;
  let previousViewportY: number | null = null;
  let frame: number | null = null;
  let disposed = false;
  return {
    schedule: () => {
      if (disposed) return;
      if (previousViewportY === null) previousViewportY = getViewportY();
      if (frame !== null) cancelFrame(frame);
      frame = requestFrame(() => {
        frame = null;
        if (disposed) return;
        const viewportY = getViewportY();
        if (viewportY !== previousViewportY) save();
        previousViewportY = viewportY;
      });
    },
    dispose: () => {
      disposed = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

export function resolveTerminalViewportRestore(args: {
  anchor: TerminalViewportAnchor | null;
  baseY: number;
  outputLineAnchors: readonly { sequence: number; line: number }[];
  replayNextSequence: number;
  replayStartSequence: number;
}): number {
  const { anchor, baseY, outputLineAnchors, replayNextSequence, replayStartSequence } =
    args;
  if (anchor === null) {
    return baseY;
  }
  if (
    replayStartSequence < anchor.outputSequence &&
    replayNextSequence < anchor.outputSequence
  ) {
    return Math.max(0, baseY - anchor.distanceFromTail);
  }
  if (anchor.outputSequence < replayStartSequence) {
    return 0;
  }
  const outputAnchor = outputLineAnchors.find(
    ({ sequence }) => sequence === anchor.outputSequence,
  );
  if (outputAnchor === undefined) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(baseY, outputAnchor.line + (anchor.lineOffset ?? 0)),
  );
}
