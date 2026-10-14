import { Buffer } from "node:buffer";

export type TerminalAttentionKind = "bell" | "osc-9" | "osc-99" | "osc-777";

export interface TerminalAttentionDetection {
  body?: string;
  kind: TerminalAttentionKind;
  title?: string;
}

export interface TerminalAttentionParserState {
  pending: string;
}

const MAX_PENDING_BYTES = 4096;

export const INITIAL_TERMINAL_ATTENTION_PARSER_STATE: TerminalAttentionParserState = {
  pending: "",
};

function parseOsc(value: string): TerminalAttentionDetection | null {
  if (value.startsWith("9;")) {
    return { body: value.slice(2), kind: "osc-9" };
  }
  if (value.startsWith("99;")) {
    const payload = value.slice(3).replace(/^(?:[a-z]=[^;]*;)+/u, "");
    const separator = payload.indexOf(";");
    return separator === -1
      ? { body: payload, kind: "osc-99" }
      : {
          body: payload.slice(separator + 1),
          kind: "osc-99",
          title: payload.slice(0, separator),
        };
  }
  if (value.startsWith("777;notify;")) {
    const payload = value.slice("777;notify;".length);
    const separator = payload.indexOf(";");
    return separator === -1
      ? { body: payload, kind: "osc-777" }
      : {
          body: payload.slice(separator + 1),
          kind: "osc-777",
          title: payload.slice(0, separator),
        };
  }
  return null;
}

export function consumeTerminalAttention(
  state: TerminalAttentionParserState,
  bytes: Uint8Array,
): TerminalAttentionDetection[] {
  let input = state.pending + Buffer.from(bytes).toString("utf8");
  state.pending = "";
  const detections: TerminalAttentionDetection[] = [];
  while (input.length > 0) {
    const start = input.indexOf("\u001b]");
    if (start < 0) {
      const bells = input.match(/\u0007/gu)?.length ?? 0;
      for (let index = 0; index < bells; index += 1) {
        detections.push({ kind: "bell" });
      }
      return detections;
    }
    const before = input.slice(0, start);
    const bells = before.match(/\u0007/gu)?.length ?? 0;
    for (let index = 0; index < bells; index += 1) {
      detections.push({ kind: "bell" });
    }
    input = input.slice(start + 2);
    const belEnd = input.indexOf("\u0007");
    const stEnd = input.indexOf("\u001b\\");
    const end = belEnd < 0 ? stEnd : stEnd < 0 ? belEnd : Math.min(belEnd, stEnd);
    if (end < 0) {
      state.pending = (`\u001b]${input}`).slice(-MAX_PENDING_BYTES);
      return detections;
    }
    const detection = parseOsc(input.slice(0, end));
    if (detection) detections.push(detection);
    input = input.slice(end + (end === belEnd ? 1 : 2));
  }
  return detections;
}
