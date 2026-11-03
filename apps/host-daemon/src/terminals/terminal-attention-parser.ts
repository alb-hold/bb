export type TerminalAttentionKind = "bell" | "osc-9" | "osc-99" | "osc-777";

export interface TerminalAttentionDetection {
  body?: string;
  kind: TerminalAttentionKind;
  title?: string;
}

export interface TerminalAttentionParserState {
  pending: string;
  osc99Assemblies?: Map<
    string,
    {
      body: Uint8Array;
      bodyBase64Carry: string;
      bodyEncoding?: "base64" | "text";
      title: Uint8Array;
      titleBase64Carry: string;
      titleEncoding?: "base64" | "text";
      bytes: number;
    }
  >;
  osc99AssemblyBytes?: number;
}

const MAX_PENDING_BYTES = 4096;
const MAX_OSC99_ASSEMBLY_BYTES = 4096;
const MAX_OSC99_ASSEMBLIES = 32;
const MAX_OSC99_PAYLOAD_BYTES = 2048;
const decoders = new WeakMap<TerminalAttentionParserState, TextDecoder>();

function decodeBase64Bytes(
  value: string,
  allowUnpadded: boolean,
): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const unpadded = value.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) return null;
  if (value.includes("=") && value.length % 4 !== 0) return null;
  if (!allowUnpadded && value.length % 4 !== 0) return null;
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      padded,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64") !== padded) return null;
  return decoded;
}

function appendBytes(current: Uint8Array, next: Uint8Array): Uint8Array {
  const result = new Uint8Array(current.length + next.length);
  result.set(current);
  result.set(next, current.length);
  return result;
}

function appendBase64Chunk(
  current: Uint8Array,
  carry: string,
  chunk: string,
  done: boolean,
): { bytes: Uint8Array; carry: string } | null {
  const combined = carry + chunk;
  if (!/^[A-Za-z0-9+/=]*$/u.test(combined)) return null;
  if (combined.includes("=")) {
    if (!/=+$/.test(combined)) return null;
    const decoded = decodeBase64Bytes(combined, false);
    return decoded ? { bytes: appendBytes(current, decoded), carry: "" } : null;
  }
  const completeLength = combined.length - (combined.length % 4);
  const complete = combined.slice(0, completeLength);
  const nextCarry = combined.slice(completeLength);
  const decoded = complete
    ? decodeBase64Bytes(complete, false)
    : new Uint8Array();
  if (!decoded) return null;
  let nextBytes = appendBytes(current, decoded);
  if (done && nextCarry) {
    const finalBytes = decodeBase64Bytes(nextCarry, true);
    if (!finalBytes) return null;
    nextBytes = appendBytes(nextBytes, finalBytes);
    return { bytes: nextBytes, carry: "" };
  }
  return { bytes: nextBytes, carry: nextCarry };
}

function decodeUtf8(value: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

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

  const payload = value.slice(secondSeparator + 1);
  const payloadEncoding = encoding === "1" ? "base64" : "text";
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (
    payloadBytes >
    (payloadEncoding === "base64"
      ? MAX_OSC99_ASSEMBLY_BYTES
      : MAX_OSC99_PAYLOAD_BYTES)
  ) {
    return null;
  }
  const id = metadata.get("i");
  const isDone = done !== "0";
  if (!id) {
    if (!isDone) return null;
    const decodedBytes =
      payloadEncoding === "base64"
        ? appendBase64Chunk(new Uint8Array(), "", payload, true)?.bytes
        : Buffer.from(payload, "utf8");
    const decodedPayload = decodedBytes ? decodeUtf8(decodedBytes) : null;
    if (
      decodedPayload === null ||
      Buffer.byteLength(decodedPayload, "utf8") > MAX_OSC99_PAYLOAD_BYTES
    ) {
      return null;
    }
    return part === "title"
      ? { kind: "osc-99", title: decodedPayload }
      : { kind: "osc-99", body: decodedPayload };
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
  const existing = assemblies.get(id) ?? {
    title: new Uint8Array(),
    titleBase64Carry: "",
    body: new Uint8Array(),
    bodyBase64Carry: "",
    bytes: 0,
  };
  const existingEncoding =
    part === "title" ? existing.titleEncoding : existing.bodyEncoding;
  if (existingEncoding !== undefined && existingEncoding !== payloadEncoding) {
    if (assemblies.delete(id)) {
      state.osc99AssemblyBytes = Math.max(
        0,
        (state.osc99AssemblyBytes ?? 0) - existing.bytes,
      );
    }
    return null;
  }
  const totalBytes = state.osc99AssemblyBytes ?? 0;
  if (totalBytes + payloadBytes > MAX_OSC99_ASSEMBLY_BYTES) {
    if (assemblies.delete(id)) {
      state.osc99AssemblyBytes = Math.max(0, totalBytes - existing.bytes);
    }
    return null;
  }
  const currentBytes = part === "title" ? existing.title : existing.body;
  const currentCarry =
    part === "title" ? existing.titleBase64Carry : existing.bodyBase64Carry;
  const appended =
    payloadEncoding === "base64"
      ? appendBase64Chunk(currentBytes, currentCarry, payload, isDone)
      : {
          bytes: appendBytes(currentBytes, Buffer.from(payload, "utf8")),
          carry: "",
        };
  if (!appended) {
    if (assemblies.delete(id)) {
      state.osc99AssemblyBytes = Math.max(
        0,
        (state.osc99AssemblyBytes ?? 0) - existing.bytes,
      );
    }
    return null;
  }
  const nextTitle = part === "title" ? appended.bytes : existing.title;
  const nextBody = part === "body" ? appended.bytes : existing.body;
  const nextTitleCarry =
    part === "title" ? appended.carry : existing.titleBase64Carry;
  const nextBodyCarry =
    part === "body" ? appended.carry : existing.bodyBase64Carry;
  const addedBytes =
    payloadEncoding === "base64"
      ? appended.bytes.length -
        currentBytes.length +
        appended.carry.length -
        currentCarry.length
      : payloadBytes;
  const nextBytes = existing.bytes + Math.max(0, addedBytes);
  if (totalBytes - existing.bytes + nextBytes > MAX_OSC99_ASSEMBLY_BYTES) {
    if (assemblies.delete(id)) {
      state.osc99AssemblyBytes = Math.max(0, totalBytes - existing.bytes);
    }
    return null;
  }

  if (!isDone) {
    assemblies.set(id, {
      title: nextTitle,
      titleBase64Carry: nextTitleCarry,
      body: nextBody,
      bodyBase64Carry: nextBodyCarry,
      titleEncoding:
        part === "title" ? payloadEncoding : existing.titleEncoding,
      bodyEncoding: part === "body" ? payloadEncoding : existing.bodyEncoding,
      bytes: nextBytes,
    });
    state.osc99AssemblyBytes = totalBytes - existing.bytes + nextBytes;
    return null;
  }

  assemblies.delete(id);
  state.osc99AssemblyBytes = Math.max(0, totalBytes - existing.bytes);
  const titleEncoding =
    part === "title" ? payloadEncoding : existing.titleEncoding;
  const bodyEncoding =
    part === "body" ? payloadEncoding : existing.bodyEncoding;
  const titleValue =
    titleEncoding === "base64"
      ? decodeUtf8(nextTitle)
      : nextTitle.length > 0
        ? decodeUtf8(nextTitle)
        : "";
  const bodyValue =
    bodyEncoding === "base64"
      ? decodeUtf8(nextBody)
      : nextBody.length > 0
        ? decodeUtf8(nextBody)
        : "";
  if (
    titleValue === null ||
    bodyValue === null ||
    (titleValue !== undefined &&
      Buffer.byteLength(titleValue, "utf8") > MAX_OSC99_PAYLOAD_BYTES) ||
    (bodyValue !== undefined &&
      Buffer.byteLength(bodyValue, "utf8") > MAX_OSC99_PAYLOAD_BYTES)
  ) {
    return null;
  }
  const title = titleValue || undefined;
  const body = bodyValue || undefined;
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
