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
  } else if (byte >= 0xc2 && byte <= 0xdf) {
    state.utf8Remaining = 1;
  } else if (byte >= 0xe0 && byte <= 0xef) {
    state.utf8Remaining = 2;
  } else if (byte >= 0xf0 && byte <= 0xf4) {
    state.utf8Remaining = 3;
  }
}
