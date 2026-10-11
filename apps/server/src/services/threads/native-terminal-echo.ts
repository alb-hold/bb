const TERMINAL_CONTROL_SEQUENCE =
  /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78DEHM]/gu;
const ECHO_IGNORED_CHARACTERS = /[\s─-╿]/gu;
const ECHO_TAIL_LENGTH = 32;
const PLACEHOLDER_DETAIL_LENGTH = 32;

export function normalizeTerminalEcho(value: string): string {
  return value
    .replace(TERMINAL_CONTROL_SEQUENCE, "")
    .replace(ECHO_IGNORED_CHARACTERS, "");
}

export function decodeTerminalOutputChunks(
  chunks: readonly { dataBase64: string }[],
): string {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
}

function textEchoMarker(text: string): string | null {
  const normalized = normalizeTerminalEcho(text);
  return normalized.length > 0 ? normalized.slice(-ECHO_TAIL_LENGTH) : null;
}

function placeholderEchoMarkers(
  output: string,
  pastePlaceholders: readonly string[],
): string[] {
  const markers: string[] = [];
  for (const placeholder of pastePlaceholders) {
    const prefix = normalizeTerminalEcho(placeholder);
    if (prefix.length === 0) continue;
    let index = output.indexOf(prefix);
    while (index !== -1) {
      const close = output.indexOf("]", index + prefix.length);
      const end =
        close !== -1 &&
        close - index <= prefix.length + PLACEHOLDER_DETAIL_LENGTH
          ? close + 1
          : index + prefix.length;
      markers.push(output.slice(index, end));
      index = output.indexOf(prefix, index + prefix.length);
    }
  }
  return markers;
}

export function terminalOutputAlreadyShowsText(args: {
  output: string;
  text: string;
}): boolean {
  const marker = textEchoMarker(args.text);
  return marker !== null && normalizeTerminalEcho(args.output).includes(marker);
}

export function terminalOutputShowsPaste(args: {
  before: string;
  output: string;
  pastePlaceholders: readonly string[];
  text: string;
}): boolean {
  const seen = normalizeTerminalEcho(args.before);
  const output = normalizeTerminalEcho(args.output);
  const textMarker = textEchoMarker(args.text);
  const markers = [
    ...(textMarker !== null && output.includes(textMarker) ? [textMarker] : []),
    ...placeholderEchoMarkers(output, args.pastePlaceholders),
  ];
  return markers.some((marker) => !seen.includes(marker));
}
