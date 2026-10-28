export const MAX_TERMINAL_REPLAY_CSI_PARAMETER_BYTES = 1024;

export interface TerminalReplayParserState {
  alternateScreen: boolean;
  controlString: "osc" | "string" | null;
  csiParameters: string;
  escape: "none" | "escape" | "intermediate" | "csi" | "csi-ignore";
  utf8Remaining: number;
}

export function createTerminalReplayParserState(): TerminalReplayParserState {
  return {
    alternateScreen: false,
    controlString: null,
    csiParameters: "",
    escape: "none",
    utf8Remaining: 0,
  };
}

export function isTerminalReplaySafeBoundary(
  state: TerminalReplayParserState,
): boolean {
  return (
    state.controlString === null &&
    state.escape === "none" &&
    state.utf8Remaining === 0
  );
}

function utf8ContinuationBytes(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 1;
  if (byte >= 0xe0 && byte <= 0xef) return 2;
  if (byte >= 0xf0 && byte <= 0xf4) return 3;
  return 0;
}

export function advanceTerminalReplayParserByte(
  state: TerminalReplayParserState,
  byte: number,
): void {
  if (byte === 0x18 || byte === 0x1a) {
    state.controlString = null;
    state.csiParameters = "";
    state.escape = "none";
    state.utf8Remaining = 0;
    return;
  }
  if (state.utf8Remaining > 0) {
    if (byte >= 0x80 && byte <= 0xbf) {
      state.utf8Remaining -= 1;
      return;
    }
    state.utf8Remaining = 0;
  }
  if (state.controlString !== null) {
    if (byte === 0x9c || (state.escape === "escape" && byte === 0x5c)) {
      state.controlString = null;
      state.escape = "none";
    } else {
      state.escape =
        state.controlString === "osc" && byte === 0x07
          ? "none"
          : byte === 0x1b
            ? "escape"
            : "none";
      if (state.controlString === "osc" && byte === 0x07) {
        state.controlString = null;
      } else {
        state.utf8Remaining = utf8ContinuationBytes(byte);
      }
    }
    return;
  }
  if (state.escape === "csi" || state.escape === "csi-ignore") {
    if (byte === 0x1b) {
      state.escape = "escape";
      state.csiParameters = "";
    } else if (byte >= 0x40 && byte <= 0x7e) {
      if (
        state.escape === "csi" &&
        (byte === 0x68 || byte === 0x6c) &&
        /^\?(?:47|1047|1049)(?:;|$)/u.test(state.csiParameters)
      ) {
        state.alternateScreen = byte === 0x68;
      }
      state.escape = "none";
      state.csiParameters = "";
    } else if (state.escape === "csi" && byte >= 0x20 && byte <= 0x3f) {
      if (
        state.csiParameters.length < MAX_TERMINAL_REPLAY_CSI_PARAMETER_BYTES
      ) {
        state.csiParameters += String.fromCharCode(byte);
      } else {
        state.csiParameters = "";
        state.escape = "csi-ignore";
      }
    }
    return;
  }
  if (state.escape === "intermediate") {
    if (byte === 0x1b) {
      state.escape = "escape";
    } else if (byte < 0x20 || byte > 0x2f) {
      state.escape = "none";
    }
    return;
  }
  if (state.escape === "escape") {
    if (byte === 0x1b) {
      state.escape = "escape";
    } else if (byte === 0x5b) {
      state.escape = "csi";
      state.csiParameters = "";
    } else if (byte === 0x5d) {
      state.controlString = "osc";
      state.escape = "none";
    } else if (
      byte === 0x50 ||
      byte === 0x58 ||
      byte === 0x5e ||
      byte === 0x5f
    ) {
      state.controlString = "string";
      state.escape = "none";
    } else if (byte >= 0x20 && byte <= 0x2f) {
      state.escape = "intermediate";
    } else {
      state.escape = "none";
    }
    return;
  }
  if (byte === 0x1b) {
    state.escape = "escape";
  } else if (byte === 0x9b) {
    state.escape = "csi";
  } else if (byte === 0x9d) {
    state.controlString = "osc";
  } else if (byte === 0x90 || byte === 0x98 || byte === 0x9e || byte === 0x9f) {
    state.controlString = "string";
  } else {
    state.utf8Remaining = utf8ContinuationBytes(byte);
  }
}

const GROUND_INERT = new Uint8Array(256).fill(1);
for (const byte of [0x18, 0x1a, 0x1b, 0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]) {
  GROUND_INERT[byte] = 0;
}
GROUND_INERT.fill(0, 0xc2, 0xf5);

const OSC_STRING_INERT = new Uint8Array(256).fill(1);
for (const byte of [0x07, 0x18, 0x1a, 0x1b, 0x9c]) {
  OSC_STRING_INERT[byte] = 0;
}
OSC_STRING_INERT.fill(0, 0xc2, 0xf5);
const OTHER_STRING_INERT = new Uint8Array(OSC_STRING_INERT);
OTHER_STRING_INERT[0x07] = 1;

function completeUtf8SequenceEnd(bytes: Uint8Array, index: number): number {
  const continuation = utf8ContinuationBytes(bytes[index] ?? 0);
  if (continuation === 0 || index + continuation >= bytes.length) return -1;
  for (let offset = 1; offset <= continuation; offset += 1) {
    const next = bytes[index + offset] ?? 0;
    if (next < 0x80 || next > 0xbf) return -1;
  }
  return index + continuation + 1;
}

function skipGroundBytes(bytes: Uint8Array, start: number): number {
  const end = bytes.length;
  let index = start;
  while (index < end) {
    const byte = bytes[index] ?? 0;
    if (GROUND_INERT[byte] === 1) {
      index += 1;
      continue;
    }
    if (byte === 0x1b && index + 1 < end) {
      const next = bytes[index + 1] ?? 0;
      if (next === 0x5b) {
        if (index + 2 < end && bytes[index + 2] === 0x3f) return index;
        let final = index + 2;
        while (
          final < end &&
          (bytes[final] ?? 0) >= 0x20 &&
          (bytes[final] ?? 0) <= 0x3f
        ) {
          final += 1;
        }
        const finalByte = bytes[final] ?? 0;
        if (
          final < end &&
          finalByte >= 0x40 &&
          finalByte <= 0x7e &&
          final - (index + 2) < MAX_TERMINAL_REPLAY_CSI_PARAMETER_BYTES
        ) {
          index = final + 1;
          continue;
        }
        return index;
      }
      if (
        next >= 0x30 &&
        next <= 0x7e &&
        next !== 0x5d &&
        next !== 0x50 &&
        next !== 0x58 &&
        next !== 0x5e &&
        next !== 0x5f
      ) {
        index += 2;
        continue;
      }
      return index;
    }
    const sequenceEnd = completeUtf8SequenceEnd(bytes, index);
    if (sequenceEnd >= 0) {
      index = sequenceEnd;
      continue;
    }
    return index;
  }
  return index;
}

function skipStringBytes(
  bytes: Uint8Array,
  start: number,
  inert: Uint8Array,
): number {
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (inert[byte] === 1) {
      index += 1;
      continue;
    }
    const sequenceEnd = completeUtf8SequenceEnd(bytes, index);
    if (sequenceEnd < 0) return index;
    index = sequenceEnd;
  }
  return index;
}

export function advanceTerminalReplayParserBytes(
  state: TerminalReplayParserState,
  bytes: Uint8Array,
  start = 0,
): void {
  let index = start;
  while (index < bytes.length) {
    if (state.escape === "none" && state.utf8Remaining === 0) {
      index =
        state.controlString === null
          ? skipGroundBytes(bytes, index)
          : skipStringBytes(
              bytes,
              index,
              state.controlString === "osc"
                ? OSC_STRING_INERT
                : OTHER_STRING_INERT,
            );
      if (index >= bytes.length) return;
    }
    advanceTerminalReplayParserByte(state, bytes[index] ?? 0);
    index += 1;
  }
}
