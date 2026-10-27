import type {
  ProviderNativeTerminalActivity,
  ProviderNativeTerminalRecordMatch,
} from "./native-terminal.js";

export type NativeTranscriptState = "idle" | "working";

type ActivityTranscript = NonNullable<
  ProviderNativeTerminalActivity["transcript"]
>;

function readRecordField(value: unknown, fieldPath: string): unknown {
  let current = value;
  for (const key of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function recordMatches(
  match: ProviderNativeTerminalRecordMatch,
  record: unknown,
): boolean {
  for (const [field, expected] of Object.entries(match.equals)) {
    if (readRecordField(record, field) !== expected) return false;
  }
  for (const [field, prefix] of Object.entries(match.startsWith ?? {})) {
    const value = readRecordField(record, field);
    if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  }
  return true;
}

export function classifyNativeTranscriptRecord(
  transcript: ActivityTranscript,
  record: unknown,
): NativeTranscriptState | null {
  if (
    transcript.prompt.some((rule) => recordMatches(rule.match, record)) ||
    transcript.working.some((rule) => recordMatches(rule, record))
  ) {
    return "working";
  }
  if (transcript.idle.some((rule) => recordMatches(rule, record))) {
    return "idle";
  }
  return null;
}
