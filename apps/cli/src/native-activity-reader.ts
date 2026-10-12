import type { ProviderNativeTerminal } from "@bb/domain";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  fileSize,
  JsonlTail,
  NativeActivityTracker,
  readRecordField,
  type NativeActivityReport,
  type NativeActivitySignal,
} from "./native-activity.js";
import {
  findNativeSessionFile,
  type NativeHarnessEnv,
} from "./native-harness.js";

const MAX_RETAINED_RECORDS = 4096;
const MAX_RETAINED_TURNS = 128;
const MAX_EVICTED_CUTOFF_IDS = 4096;

export type NativeActivityStart =
  | { kind: "discover" }
  | { kind: "start"; id: string }
  | { kind: "resume"; id: string; transcriptFile: string; offset: number };

export interface ResumedTranscriptBaseline {
  transcriptFile: string;
  offset: number;
}

export async function measureResumedTranscript(
  cli: ProviderNativeTerminal,
  env: NativeHarnessEnv,
  sessionId: string,
  options: {
    attempts?: number;
    delayMs?: number;
    measure?: (filePath: string) => number | null;
  } = {},
): Promise<ResumedTranscriptBaseline> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 200;
  const measure = options.measure ?? fileSize;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let transcriptFile: string | null;
    try {
      transcriptFile = findNativeSessionFile(cli, env, sessionId);
    } catch {
      transcriptFile = null;
    }
    const offset = transcriptFile === null ? null : measure(transcriptFile);
    if (transcriptFile !== null && offset !== null) {
      return { transcriptFile, offset };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `bb could not read the ${cli.executable} transcript of session ${sessionId}, so it did not resume it.`,
  );
}

export class NativeActivityReader {
  private readonly tracker = new NativeActivityTracker();
  private readonly hookTail = new JsonlTail(0);
  private readonly transcriptTail: JsonlTail;
  private transcriptFile: string | null;
  private sessionId: string | null;
  private currentTurn: string | null = null;
  private workingRecord: string | null = null;
  private evictedThroughTimestamp: number | null = null;
  private evictedThroughPosition = 0;
  private transcriptPosition = 0;
  private readonly transcriptStartOffset: number;
  private cutoffIdsOverflowed = false;
  private readonly evictedCutoffIds = new Set<string>();
  private readonly knownTurns = new Set<string>();
  private readonly recordTurns = new Map<string, string | null>();
  private readonly recordParents = new Map<
    string,
    { parent: string | null; timestamp: number | null; position: number }
  >();
  private readonly completedTurns = new Map<string, string>();

  constructor(
    private readonly cli: ProviderNativeTerminal,
    private readonly env: NativeHarnessEnv,
    private readonly eventsFile: string | null,
    start: NativeActivityStart,
  ) {
    this.transcriptStartOffset = start.kind === "resume" ? start.offset : 0;
    if (start.kind === "resume") {
      this.sessionId = start.id;
      this.transcriptFile = start.transcriptFile;
      this.transcriptTail = new JsonlTail(start.offset);
    } else {
      this.sessionId = start.kind === "start" ? start.id : null;
      this.transcriptFile = this.findTranscript();
      this.transcriptTail = new JsonlTail(0);
    }
  }

  sessionDiscovered(sessionId: string): void {
    this.sessionId = sessionId;
  }

  read(): NativeActivityReport[] {
    const activity = this.cli.activity;
    if (activity === undefined) return [];
    const reports: NativeActivityReport[] = [];
    const push = (report: NativeActivityReport | null): void => {
      if (report !== null) reports.push(report);
    };
    const hooks = activity.hooks;
    if (hooks !== undefined && this.eventsFile !== null) {
      for (const record of this.hookTail.readRecords(this.eventsFile)) {
        const signal = classifyHookRecord(hooks, record);
        const turn =
          hooks.turnId === undefined
            ? null
            : this.stringField(record, hooks.turnId);
        if (turn !== null && signal.state === "working") {
          if (this.completedTurns.has(turn)) continue;
          if (this.currentTurn !== turn && this.knownTurns.has(turn)) continue;
          this.currentTurn = turn;
          this.rememberTurn(turn);
        }
        push(this.tracker.apply(signal));
      }
    }
    const transcript = activity.transcript;
    if (transcript === undefined) return reports;
    this.transcriptFile ??= this.findTranscript();
    if (this.transcriptFile === null) return reports;
    for (const record of this.transcriptTail.readRecords(this.transcriptFile)) {
      const signal = classifyTranscriptRecord(transcript, record);
      push(this.tracker.apply(this.identifyTranscript(record, signal)));
    }
    return reports;
  }

  heartbeat(): NativeActivityReport | null {
    return this.tracker.heartbeat();
  }

  finish(): NativeActivityReport | null {
    return this.tracker.finish();
  }

  private findTranscript(): string | null {
    if (this.sessionId === null) return null;
    try {
      return findNativeSessionFile(this.cli, this.env, this.sessionId);
    } catch {
      return null;
    }
  }

  private stringField(record: unknown, field: string): string | null {
    const value = readRecordField(record, field);
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private identifyTranscript(
    record: unknown,
    signal: NativeActivitySignal,
  ): NativeActivitySignal {
    const identity = this.cli.activity?.transcript?.identity;
    if (identity === undefined) return signal;
    this.transcriptPosition += 1;
    const ignored = { state: null, prompt: null };
    const id = this.stringField(record, identity.recordId);
    if (id === null || this.recordTurns.has(id)) return ignored;
    let timestamp: number | null = null;
    if (identity.timestamp !== undefined) {
      const value = this.stringField(record, identity.timestamp);
      if (value === null) return ignored;
      timestamp = Date.parse(value);
      if (
        !Number.isFinite(timestamp) ||
        (this.evictedThroughTimestamp !== null &&
          ((timestamp < this.evictedThroughTimestamp &&
            this.wasEvictedInTranscript(id)) ||
            (timestamp === this.evictedThroughTimestamp &&
              (this.evictedCutoffIds.has(id) ||
                (this.cutoffIdsOverflowed &&
                  this.wasEvictedInTranscript(id))))))
      ) {
        return ignored;
      }
    }
    const parent = this.stringField(record, identity.parentId);
    const turn =
      this.stringField(record, identity.turnId) ??
      (parent === null ? null : (this.recordTurns.get(parent) ?? null));
    const completed = turn === null ? undefined : this.completedTurns.get(turn);
    const retainedParent =
      completed !== undefined &&
      parent !== null &&
      (parent === completed || this.descendsFrom(parent, completed))
        ? completed
        : parent;
    this.recordTurns.set(id, turn);
    this.recordParents.set(id, {
      parent: retainedParent,
      timestamp,
      position: this.transcriptPosition,
    });
    this.pruneRecords();
    if (turn === null || signal.state === null) return ignored;
    if (this.currentTurn !== turn) {
      if (
        this.currentTurn !== null &&
        this.cli.activity?.hooks?.turnId !== undefined
      ) {
        return ignored;
      }
      if (signal.state !== "working" || this.knownTurns.has(turn))
        return ignored;
      this.currentTurn = turn;
      this.rememberTurn(turn);
    }
    if (completed !== undefined) {
      if (signal.state !== "working" || !this.descendsFrom(id, completed)) {
        return ignored;
      }
      this.completedTurns.delete(turn);
    }
    if (signal.state === "idle") this.completedTurns.set(turn, id);
    if (signal.state === "working") this.workingRecord = id;
    return signal;
  }

  private rememberTurn(turn: string): void {
    this.knownTurns.add(turn);
    if (this.knownTurns.size <= MAX_RETAINED_TURNS) return;
    const expired = this.knownTurns.values().next().value;
    if (expired !== undefined) {
      this.knownTurns.delete(expired);
      this.completedTurns.delete(expired);
    }
  }

  private pruneRecords(): void {
    if (this.recordTurns.size <= MAX_RETAINED_RECORDS) return;
    for (const [id, turn] of this.recordTurns) {
      if (
        id === this.workingRecord ||
        (turn !== null && this.completedTurns.get(turn) === id)
      ) {
        continue;
      }
      const record = this.recordParents.get(id);
      if (record !== undefined && record.timestamp !== null) {
        this.evictedThroughPosition = Math.max(
          this.evictedThroughPosition,
          record.position,
        );
        if (
          this.evictedThroughTimestamp === null ||
          record.timestamp > this.evictedThroughTimestamp
        ) {
          this.evictedThroughTimestamp = record.timestamp;
          this.evictedCutoffIds.clear();
          this.cutoffIdsOverflowed = false;
        }
        if (record.timestamp === this.evictedThroughTimestamp) {
          this.evictedCutoffIds.add(id);
          if (this.evictedCutoffIds.size > MAX_EVICTED_CUTOFF_IDS) {
            const expired = this.evictedCutoffIds.values().next().value;
            if (expired !== undefined) this.evictedCutoffIds.delete(expired);
            this.cutoffIdsOverflowed = true;
          }
        }
      }
      this.recordTurns.delete(id);
      this.recordParents.delete(id);
      break;
    }
  }

  private wasEvictedInTranscript(id: string): boolean {
    const identity = this.cli.activity?.transcript?.identity;
    if (this.transcriptFile === null || identity === undefined) return false;
    const tail = new JsonlTail(this.transcriptStartOffset);
    let position = 0;
    while (position < this.evictedThroughPosition) {
      const records = tail.readRecords(this.transcriptFile);
      if (records.length === 0) return false;
      for (const record of records) {
        position += 1;
        if (position > this.evictedThroughPosition) return false;
        if (this.stringField(record, identity.recordId) === id) return true;
      }
    }
    return false;
  }

  private descendsFrom(id: string, ancestor: string): boolean {
    const visited = new Set<string>();
    let parent = this.recordParents.get(id)?.parent ?? null;
    while (parent !== null && !visited.has(parent)) {
      if (parent === ancestor) return true;
      visited.add(parent);
      parent = this.recordParents.get(parent)?.parent ?? null;
    }
    return false;
  }
}
