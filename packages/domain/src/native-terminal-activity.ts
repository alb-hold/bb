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
  for (const field of match.present ?? []) {
    if (readRecordField(record, field) === undefined) return false;
  }
  for (const field of match.absent ?? []) {
    if (readRecordField(record, field) !== undefined) return false;
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

export function readNativeTranscriptRecordTimestamp(
  transcript: ActivityTranscript,
  record: unknown,
): number | null {
  const field = transcript.identity?.timestamp;
  if (field === undefined) return null;
  const value = readRecordField(record, field);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
