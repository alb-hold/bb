export type TerminalAttentionKind = "bell" | "osc-9" | "osc-99" | "osc-777";

export interface TerminalAttentionDetection {
  body?: string;
  kind: TerminalAttentionKind;
  title?: string;
}

export interface TerminalAttentionParserState {
  pending: string;
  osc99Assemblies?: Map<string, { body: string; title: string; bytes: number }>;
  osc99AssemblyBytes?: number;
}

const MAX_PENDING_BYTES = 4096;
const MAX_OSC99_ASSEMBLY_BYTES = 4096;
const MAX_OSC99_ASSEMBLIES = 32;
const MAX_OSC99_PAYLOAD_BYTES = 2048;
const decoders = new WeakMap<TerminalAttentionParserState, TextDecoder>();

export const INITIAL_TERMINAL_ATTENTION_PARSER_STATE: TerminalAttentionParserState =
  {
    pending: "",
  };

function parseOsc(value: string): TerminalAttentionDetection | null {
  if (value.startsWith("9;")) {
    if (/^9;\d+;/u.test(value)) return null;
    return { body: value.slice(2), kind: "osc-9" };
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

function parseOsc99(
  state: TerminalAttentionParserState,
  value: string,
): TerminalAttentionDetection | null {
  const firstSeparator = value.indexOf(";");
  const secondSeparator = value.indexOf(";", firstSeparator + 1);
  if (firstSeparator !== 2 || secondSeparator < 0) return null;

  const metadata = new Map<string, string>();
  const metadataFields = value
    .slice(firstSeparator + 1, secondSeparator)
    .split(":");
  for (const field of metadataFields) {
    if (!field) continue;
    const equals = field.indexOf("=");
    if (equals !== 1) return null;
    metadata.set(field.slice(0, 1), field.slice(2));
  }

  const part = metadata.get("p") ?? "title";
  if (part === "?") return null;
  if (part !== "title" && part !== "body") return null;
  const done = metadata.get("d");
  if (done !== undefined && done !== "0" && done !== "1") return null;
  const encoding = metadata.get("e");
  if (encoding !== undefined && encoding !== "1") return null;

  let payload = value.slice(secondSeparator + 1);
  if (encoding === "1") {
    if (
      payload.length > MAX_OSC99_PAYLOAD_BYTES * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        payload,
      )
    ) {
      return null;
    }
    const encodedPayload = payload;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(payload, "base64"),
      );
      if (Buffer.from(payload, "utf8").toString("base64") !== encodedPayload) {
        return null;
      }
    } catch {
      return null;
    }
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_OSC99_PAYLOAD_BYTES) return null;

  const id = metadata.get("i");
  const isDone = done !== "0";
  if (!id) {
    if (!isDone) return null;
    return part === "title"
      ? { kind: "osc-99", title: payload }
      : { kind: "osc-99", body: payload };
  }

  const assemblies = (state.osc99Assemblies ??= new Map());
  if (!assemblies.has(id) && assemblies.size >= MAX_OSC99_ASSEMBLIES) {
    const oldestId = assemblies.keys().next().value;
    if (oldestId !== undefined) {
      const oldest = assemblies.get(oldestId);
      assemblies.delete(oldestId);
      state.osc99AssemblyBytes = Math.max(
        0,
        (state.osc99AssemblyBytes ?? 0) - (oldest?.bytes ?? 0),
      );
    }
  }
  const existing = assemblies.get(id) ?? { title: "", body: "", bytes: 0 };
  const nextTitle = existing.title + (part === "title" ? payload : "");
  const nextBody = existing.body + (part === "body" ? payload : "");
  const addedBytes = Buffer.byteLength(payload, "utf8");
  const nextBytes = existing.bytes + addedBytes;
  const totalBytes = state.osc99AssemblyBytes ?? 0;
  if (
    totalBytes - existing.bytes + nextBytes > MAX_OSC99_ASSEMBLY_BYTES
  ) {
    if (assemblies.delete(id)) {
      state.osc99AssemblyBytes = Math.max(0, totalBytes - existing.bytes);
    }
    return null;
  }

  if (!isDone) {
    assemblies.set(id, { title: nextTitle, body: nextBody, bytes: nextBytes });
    state.osc99AssemblyBytes = totalBytes - existing.bytes + nextBytes;
    return null;
  }

  assemblies.delete(id);
  state.osc99AssemblyBytes = Math.max(0, totalBytes - existing.bytes);
  const title = nextTitle || undefined;
  const body = nextBody || undefined;
  return title || body ? { kind: "osc-99", title, body } : null;
}

export function consumeTerminalAttention(
  state: TerminalAttentionParserState,
  bytes: Uint8Array,
): TerminalAttentionDetection[] {
  let decoder = decoders.get(state);
  if (!decoder) {
    decoder = new TextDecoder();
    decoders.set(state, decoder);
  }
  let input = state.pending + decoder.decode(bytes, { stream: true });
  state.pending = "";
  const detections: TerminalAttentionDetection[] = [];
  while (input.length > 0) {
    const start = input.indexOf("\u001b]");
    if (start < 0) {
      const bells = input.match(/\u0007/gu)?.length ?? 0;
      for (let index = 0; index < bells; index += 1) {
        detections.push({ kind: "bell" });
      }
      if (input.endsWith("\u001b")) state.pending = "\u001b";
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
    const end =
      belEnd < 0 ? stEnd : stEnd < 0 ? belEnd : Math.min(belEnd, stEnd);
    if (end < 0) {
      state.pending = `\u001b]${input}`.slice(-MAX_PENDING_BYTES);
      return detections;
    }
    const osc = input.slice(0, end);
    const detection = osc.startsWith("99;")
      ? parseOsc99(state, osc)
      : parseOsc(osc);
    if (detection) detections.push(detection);
    input = input.slice(end + (end === belEnd ? 1 : 2));
  }
  return detections;
}
