import { closeSync, openSync, readSync, statSync } from "node:fs";
import type {
  ProviderNativeTerminalActivity,
  ProviderNativeTerminalRecordMatch,
} from "@bb/domain";

export type NativeActivityState = "working" | "idle";

export interface NativeQuestion {
  id: string;
  prompt: string;
}

export interface NativeActivitySignal {
  state: NativeActivityState | null;
  prompt: string | null;
  question?: NativeQuestion;
  answered?: string;
  occurrence?: true;
}

export type NativeActivityReport =
  | { state: NativeActivityState; prompt: string | null; confirms?: false }
  | { state: "waiting"; prompt: null; questions: NativeQuestion[] };

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
  const entries = [
    ...new Set([
      ...hooks.working,
      ...hooks.idle,
      ...(hooks.pending ?? []),
      ...(hooks.permission?.open ?? []),
      ...(hooks.permission?.close ?? []),
    ]),
  ].map(
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
  const permission = hooks.permission;
  if (permission !== undefined) {
    const id = readRecordField(record, permission.idField);
    if (typeof id === "string" && id.length > 0) {
      if (permission.open.includes(event)) {
        if (permission.skip?.includes(id)) return { state: null, prompt: null };
        return {
          state: null,
          prompt: null,
          question: {
            id: `permission:${id}`,
            prompt: `${permission.label}: ${id}`,
          },
          occurrence: true,
        };
      }
      if (permission.close.includes(event)) {
        return {
          state: null,
          prompt: null,
          answered: `permission:${id}`,
          occurrence: true,
        };
      }
    }
  }
  if (hooks.working.includes(event)) {
    return {
      state: "working",
      prompt: promptText(readRecordField(record, hooks.promptField)),
    };
  }
  if (hooks.idle.includes(event)) return { state: "idle", prompt: null };
  return { state: null, prompt: null };
}

export function recordMatches(
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
  for (const rule of transcript.questions?.open ?? []) {
    if (!recordMatches(rule.match, record)) continue;
    const id = readRecordField(record, rule.id);
    if (typeof id !== "string" || id.length === 0) continue;
    return {
      state: null,
      prompt: null,
      question: {
        id,
        prompt:
          (rule.prompt === undefined
            ? null
            : promptText(readRecordField(record, rule.prompt))) ?? rule.label,
      },
    };
  }
  for (const rule of transcript.questions?.close ?? []) {
    if (!recordMatches(rule.match, record)) continue;
    const id = readRecordField(record, rule.id);
    if (typeof id === "string" && id.length > 0) {
      return { state: null, prompt: null, answered: id };
    }
  }
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

export interface JsonlRecordLocation {
  offset: number;
  length: number;
}

const TAIL_WINDOW_BYTES = 64 * 1024;

export function readTailJsonlRecords(filePath: string): unknown[] {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "r");
    const size = statSync(filePath).size;
    const length = Math.min(size, TAIL_WINDOW_BYTES);
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (size > length) lines.shift();
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
  } catch {
    return [];
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export class JsonlTail {
  private partial: Buffer = Buffer.alloc(0);

  constructor(private offset: number) {}

  readRecords(
    filePath: string,
    accept?: (record: unknown, location: JsonlRecordLocation) => void,
  ): unknown[] {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
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
    const startOffset = this.offset - this.partial.length;
    this.offset += read;
    const contents =
      this.partial.length === 0
        ? buffer.subarray(0, read)
        : Buffer.concat([this.partial, buffer.subarray(0, read)]);
    const records: unknown[] = [];
    let start = 0;
    let end: number;
    while ((end = contents.indexOf(10, start)) !== -1) {
      const line = contents.subarray(start, end).toString("utf8");
      const location = { offset: startOffset + start, length: end - start };
      start = end + 1;
      if (line.trim().length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (accept === undefined) records.push(record);
      else accept(record, location);
    }
    this.partial = Buffer.from(contents.subarray(start));
    return records;
  }
}

export class NativeActivityTracker {
  private state: NativeActivityState = "idle";
  private reportedPrompt: string | null = null;
  private readonly questions = new Map<string, string>();
  private readonly occurrenceCounters = new Map<string, number>();
  private readonly openOccurrences = new Map<string, string[]>();

  apply(signal: NativeActivitySignal): NativeActivityReport | null {
    if (signal.question !== undefined) {
      return this.openQuestion(
        signal.occurrence === true
          ? this.startOccurrence(signal.question)
          : signal.question,
      );
    }
    if (signal.answered !== undefined) {
      if (signal.occurrence !== true) return this.closeQuestion(signal.answered);
      const occurrence = this.endOldestOccurrence(signal.answered);
      return occurrence === null ? null : this.closeQuestion(occurrence);
    }
    if (signal.state === "idle") {
      this.clearQuestions();
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
    if (newPrompt !== null) this.clearQuestions();
    if (this.state === "working" && newPrompt === null) return null;
    this.state = "working";
    if (newPrompt !== null) this.reportedPrompt = newPrompt;
    return { state: "working", prompt: newPrompt };
  }

  heartbeat(): NativeActivityReport | null {
    if (this.questions.size > 0) return this.waitingReport();
    return this.state === "working" ? { state: "working", prompt: null } : null;
  }

  finish(): NativeActivityReport | null {
    return this.apply({ state: "idle", prompt: null });
  }

  private clearQuestions(): void {
    this.questions.clear();
    this.openOccurrences.clear();
  }

  private startOccurrence(question: NativeQuestion): NativeQuestion {
    const serial = (this.occurrenceCounters.get(question.id) ?? 0) + 1;
    this.occurrenceCounters.set(question.id, serial);
    const id = `${question.id}#${serial}`;
    this.openOccurrences.set(question.id, [
      ...(this.openOccurrences.get(question.id) ?? []),
      id,
    ]);
    return { id, prompt: question.prompt };
  }

  private endOldestOccurrence(baseId: string): string | null {
    const open = this.openOccurrences.get(baseId);
    const oldest = open?.[0];
    if (open === undefined || oldest === undefined) return null;
    if (open.length === 1) this.openOccurrences.delete(baseId);
    else this.openOccurrences.set(baseId, open.slice(1));
    return oldest;
  }

  private openQuestion(question: NativeQuestion): NativeActivityReport | null {
    if (this.questions.get(question.id) === question.prompt) return null;
    this.state = "working";
    this.questions.set(question.id, question.prompt);
    return this.waitingReport();
  }

  private closeQuestion(id: string): NativeActivityReport | null {
    if (!this.questions.delete(id)) return null;
    return this.questions.size > 0
      ? this.waitingReport()
      : { state: "working", prompt: null };
  }

  private waitingReport(): NativeActivityReport {
    return {
      state: "waiting",
      prompt: null,
      questions: [...this.questions].map(([id, prompt]) => ({ id, prompt })),
    };
  }
}
