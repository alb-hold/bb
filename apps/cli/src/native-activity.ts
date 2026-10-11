import { closeSync, openSync, readSync, statSync } from "node:fs";
import type {
  ProviderNativeTerminalActivity,
  ProviderNativeTerminalRecordMatch,
} from "@bb/domain";

export type NativeActivityState = "working" | "idle";

export interface NativeActivitySignal {
  state: NativeActivityState | null;
  prompt: string | null;
}

export interface NativeActivityReport {
  state: NativeActivityState;
  prompt: string | null;
}

type ActivityHooks = NonNullable<ProviderNativeTerminalActivity["hooks"]>;
type ActivityTranscript = NonNullable<
  ProviderNativeTerminalActivity["transcript"]
>;

const MAX_PROMPT_LENGTH = 4_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;

export function readRecordField(value: unknown, fieldPath: string): unknown {
  let current = value;
  for (const key of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function nativeActivityHookSettings(
  hooks: ActivityHooks,
  eventsFile: string,
): string {
  const file = shellQuote(eventsFile);
  const command = `{ cat; echo; } >> ${file} 2>/dev/null; exit 0`;
  const entries = [...new Set([...hooks.working, ...hooks.idle])].map(
    (event) => [event, [{ hooks: [{ type: "command", command }] }]] as const,
  );
  return JSON.stringify({ hooks: Object.fromEntries(entries) });
}

function promptText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length === 0 ? null : text.slice(0, MAX_PROMPT_LENGTH);
}

export function classifyHookRecord(
  hooks: ActivityHooks,
  record: unknown,
): NativeActivitySignal {
  const event = readRecordField(record, "hook_event_name");
  if (typeof event !== "string") return { state: null, prompt: null };
  if (hooks.working.includes(event)) {
    return {
      state: "working",
      prompt: promptText(readRecordField(record, hooks.promptField)),
    };
  }
  if (hooks.idle.includes(event)) return { state: "idle", prompt: null };
  return { state: null, prompt: null };
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

export function classifyTranscriptRecord(
  transcript: ActivityTranscript,
  record: unknown,
): NativeActivitySignal {
  for (const rule of transcript.prompt) {
    if (recordMatches(rule.match, record)) {
      const prompt = promptText(readRecordField(record, rule.text));
      if (prompt !== null) return { state: "working", prompt };
    }
  }
  if (transcript.idle.some((match) => recordMatches(match, record))) {
    return { state: "idle", prompt: null };
  }
  if (transcript.working.some((match) => recordMatches(match, record))) {
    return { state: "working", prompt: null };
  }
  return { state: null, prompt: null };
}

export function fileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

export class JsonlTail {
  private partial = "";

  constructor(private offset: number) {}

  readRecords(filePath: string): unknown[] {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return [];
    const length = Math.min(size - this.offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(filePath, "r");
      read = readSync(descriptor, buffer, 0, length, this.offset);
    } catch {
      return [];
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
    this.offset += read;
    const lines = (
      this.partial + buffer.subarray(0, read).toString("utf8")
    ).split("\n");
    this.partial = lines.pop() ?? "";
    const records: unknown[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return records;
  }
}

export class NativeActivityTracker {
  private state: NativeActivityState = "idle";
  private reportedPrompt: string | null = null;

  apply(signal: NativeActivitySignal): NativeActivityReport | null {
    if (signal.state === "idle") {
      if (this.state === "idle") return null;
      this.state = "idle";
      this.reportedPrompt = null;
      return { state: "idle", prompt: null };
    }
    if (signal.state !== "working") return null;
    const newPrompt =
      signal.prompt !== null && signal.prompt !== this.reportedPrompt
        ? signal.prompt
        : null;
    if (this.state === "working" && newPrompt === null) return null;
    this.state = "working";
    if (newPrompt !== null) this.reportedPrompt = newPrompt;
    return { state: "working", prompt: newPrompt };
  }

  heartbeat(): NativeActivityReport | null {
    return this.state === "working" ? { state: "working", prompt: null } : null;
  }

  finish(): NativeActivityReport | null {
    return this.apply({ state: "idle", prompt: null });
  }
}
