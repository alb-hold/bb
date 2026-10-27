export interface TerminalViewportAnchor {
  distanceFromTail: number;
  lineOffset?: number;
  outputSequence: number;
}

export interface TerminalOutputLineAnchor {
  sequence: number;
  readonly line: number;
  expired: boolean;
}

export const TERMINAL_OUTPUT_BOUNDARY_OSC_IDENTIFIER = 7778;

export function registerTerminalOutputBoundaryHandler(
  parser: {
    registerOscHandler(
      identifier: number,
      callback: (payload: string) => boolean | Promise<boolean>,
    ): { dispose(): void };
  },
  token: string,
  onOutputStart: (sequence: number) => void,
): { dispose(): void } {
  return parser.registerOscHandler(
    TERMINAL_OUTPUT_BOUNDARY_OSC_IDENTIFIER,
    (payload) => {
      const [receivedToken, sequenceText] = payload.split(":");
      const sequence = Number(sequenceText);
      if (
        receivedToken !== token ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      ) {
        return false;
      }
      onOutputStart(sequence);
      return true;
    },
  );
}

export function terminalOutputBoundaryPrefix(
  token: string,
  sequence: number,
): string {
  return `\u001b]${TERMINAL_OUTPUT_BOUNDARY_OSC_IDENTIFIER};${token}:${sequence}\u0007`;
}

export function createTerminalOutputLineAnchorTracker(args: {
  registerMarker: () =>
    | {
        line: number;
        isDisposed: boolean;
        onDispose: (listener: () => void) => { dispose: () => void };
        dispose: () => void;
      }
    | undefined;
  getCurrentLine: () => number;
}): {
  recordOutputStart: (sequence: number) => TerminalOutputLineAnchor | undefined;
  updatePinnedAnchor: (
    current: TerminalOutputLineAnchor | null,
    next: TerminalOutputLineAnchor | null,
    retainedAnchors: readonly TerminalOutputLineAnchor[],
  ) => TerminalOutputLineAnchor | null;
  forget: (anchors: readonly TerminalOutputLineAnchor[]) => void;
  reset: () => void;
  dispose: () => void;
} {
  const { registerMarker, getCurrentLine } = args;
  type MutableAnchor = {
    sequence: number;
    lineOffset: number;
    line: number;
    expired: boolean;
  };
  let reference:
    | { marker: NonNullable<ReturnType<typeof registerMarker>> }
    | undefined;
  let disposed = false;
  const anchors = new Set<MutableAnchor>();
  const pinnedAnchors = new Set<MutableAnchor>();

  const expireAnchors = () => {
    for (const anchor of anchors) {
      anchor.expired = true;
    }
    anchors.clear();
    pinnedAnchors.clear();
  };

  const attachReference = () => {
    const marker = registerMarker();
    if (!marker) {
      reference = undefined;
      return;
    }
    const current = { marker };
    reference = current;
    marker.onDispose(() => {
      if (disposed || reference !== current) return;
      reference = undefined;
      expireAnchors();
    });
  };

  const clear = () => {
    const previous = reference;
    reference = undefined;
    previous?.marker.dispose();
    expireAnchors();
  };

  const reset = () => {
    clear();
    attachReference();
  };

  const tracker = {
    recordOutputStart: (sequence: number) => {
      if (!reference || reference.marker.isDisposed) {
        if (reference?.marker.isDisposed) expireAnchors();
        attachReference();
      }
      if (!reference) return undefined;
      const currentLine = getCurrentLine();
      if (currentLine - reference.marker.line >= 256) {
        const previous = reference;
        const marker = registerMarker();
        if (marker) {
          const next = { marker };
          const shift = marker.line - previous.marker.line;
          for (const anchor of anchors) {
            anchor.lineOffset -= shift;
            if (marker.line + anchor.lineOffset < 0) {
              anchor.expired = true;
              anchors.delete(anchor);
            }
          }
          reference = next;
          marker.onDispose(() => {
            if (disposed || reference !== next) return;
            reference = undefined;
            expireAnchors();
          });
          previous.marker.dispose();
        }
      }
      if (!reference) return undefined;
      const line = getCurrentLine();
      const anchor: MutableAnchor = {
        sequence,
        lineOffset: line - reference.marker.line,
        line: 0,
        expired: false,
      };
      Object.defineProperty(anchor, "line", {
        enumerable: true,
        get: () =>
          anchor.expired
            ? -1
            : (reference?.marker.line ?? -1) + anchor.lineOffset,
      });
      anchors.add(anchor);
      return anchor;
    },
    updatePinnedAnchor: (
      current: TerminalOutputLineAnchor | null,
      next: TerminalOutputLineAnchor | null,
      retainedAnchors: readonly TerminalOutputLineAnchor[],
    ) => {
      if (current === next) return next;
      if (current !== null) {
        pinnedAnchors.delete(current as MutableAnchor);
        if (!retainedAnchors.includes(current)) {
          anchors.delete(current as MutableAnchor);
          (current as MutableAnchor).expired = true;
        }
      }
      if (next !== null) pinnedAnchors.add(next as MutableAnchor);
      return next;
    },
    forget: (dropped: readonly TerminalOutputLineAnchor[]) => {
      for (const anchor of dropped) {
        if (pinnedAnchors.has(anchor as MutableAnchor)) continue;
        anchors.delete(anchor as MutableAnchor);
        (anchor as MutableAnchor).expired = true;
      }
    },
    reset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
  return tracker;
}

export function startTerminalOutputReplay(args: {
  outputLineAnchors: TerminalOutputLineAnchor[];
  sequence: number;
  tracker: Pick<
    ReturnType<typeof createTerminalOutputLineAnchorTracker>,
    "forget" | "recordOutputStart" | "reset"
  >;
}): void {
  const outputAnchor = args.tracker.recordOutputStart(args.sequence);
  if (!outputAnchor) return;
  args.outputLineAnchors.push(outputAnchor);
  if (args.outputLineAnchors.length > 4096) {
    const removed = args.outputLineAnchors.splice(
      0,
      args.outputLineAnchors.length - 4096,
    );
    args.tracker.forget(removed);
  }
}

export function findTerminalOutputLineAnchor(
  anchors: readonly TerminalOutputLineAnchor[],
  visibleLine: number,
): TerminalOutputLineAnchor | undefined {
  let visibleAnchor: TerminalOutputLineAnchor | undefined;
  for (const anchor of anchors) {
    if (!anchor.expired && anchor.line >= 0 && anchor.line <= visibleLine) {
      visibleAnchor = anchor;
    }
  }
  return (
    visibleAnchor ??
    anchors.find((anchor) => !anchor.expired && anchor.line >= 0)
  );
}

export interface TerminalViewportStorage extends Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
> {}

export function terminalViewportStorageForClient(
  clientWindow: Pick<Window, "sessionStorage">,
): TerminalViewportStorage {
  return clientWindow.sessionStorage;
}

export function terminalViewportStorageKey(terminalId: string): string {
  return `bb:terminal-viewport:${terminalId}`;
}

const terminalViewportStoragePrefix = "bb:terminal-viewport:";
const terminalViewportIndexKey = `${terminalViewportStoragePrefix}index`;
const terminalViewportLimit = 200;

function isTerminalViewportAnchor(
  value: unknown,
): value is TerminalViewportAnchor {
  return (
    typeof value === "object" &&
    value !== null &&
    "distanceFromTail" in value &&
    Number.isInteger(value.distanceFromTail) &&
    typeof value.distanceFromTail === "number" &&
    value.distanceFromTail >= 0 &&
    (!("lineOffset" in value) ||
      (typeof value.lineOffset === "number" &&
        Number.isInteger(value.lineOffset))) &&
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

export function resolveTerminalViewportRestore(
  args: {
    anchor: TerminalViewportAnchor | null;
    baseY: number;
    outputLineAnchors: readonly TerminalOutputLineAnchor[];
    replayNextSequence: number;
    replayStartSequence: number;
  },
  onBranch?: (
    branch:
      | "no-anchor"
      | "sequence-reset-tail"
      | "expired-to-top"
      | "retained-anchor",
  ) => void,
): number {
  const {
    anchor,
    baseY,
    outputLineAnchors,
    replayNextSequence,
    replayStartSequence,
  } = args;
  if (anchor === null) {
    onBranch?.("no-anchor");
    return baseY;
  }
  if (
    replayStartSequence < anchor.outputSequence &&
    replayNextSequence < anchor.outputSequence
  ) {
    onBranch?.("sequence-reset-tail");
    return Math.max(0, baseY - anchor.distanceFromTail);
  }
  const outputAnchor = outputLineAnchors.find(
    ({ sequence }) => sequence === anchor.outputSequence,
  );
  if (
    outputAnchor === undefined ||
    outputAnchor.expired ||
    outputAnchor.line < 0
  ) {
    onBranch?.("expired-to-top");
    return 0;
  }
  onBranch?.("retained-anchor");
  return Math.max(
    0,
    Math.min(baseY, outputAnchor.line + Math.max(0, anchor.lineOffset ?? 0)),
  );
}
