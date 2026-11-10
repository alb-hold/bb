import {
  TERMINAL_REPLAY_BATCH_MAX_BYTES,
  type TerminalOutputChunk,
} from "@bb/server-contract";

export function* terminalReplayFrames(
  chunks: readonly TerminalOutputChunk[],
  batched: boolean,
): Generator<string> {
  const prefix = '{"type":"output-batch","chunks":[';
  const suffix = "]}";
  let parts: string[] = [];
  let bytes = prefix.length + suffix.length;
  let previousSeq: number | null = null;
  for (const chunk of chunks) {
    if (!batched) {
      yield JSON.stringify({ type: "output", chunk });
      continue;
    }
    const part = JSON.stringify(chunk);
    if (
      parts.length > 0 &&
      (bytes + part.length + 1 > TERMINAL_REPLAY_BATCH_MAX_BYTES ||
        parts.length === 512 ||
        chunk.seq !== (previousSeq ?? -1) + 1)
    ) {
      yield prefix + parts.join(",") + suffix;
      parts = [];
      bytes = prefix.length + suffix.length;
    }
    bytes += part.length + (parts.length > 0 ? 1 : 0);
    parts.push(part);
    previousSeq = chunk.seq;
  }
  if (parts.length > 0) yield prefix + parts.join(",") + suffix;
}
