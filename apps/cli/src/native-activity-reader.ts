import type { ProviderNativeTerminal } from "@bb/domain";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  fileSize,
  JsonlTail,
  NativeActivityTracker,
  readRecordField,
  type JsonlRecordLocation,
  type NativeActivityReport,
  type NativeActivitySignal,
} from "./native-activity.js";
import { statSync } from "node:fs";
import { EvictedRecordIndex } from "./native-activity-index.js";
import {
  findNativeSessionFile,
  type NativeHarnessEnv,
} from "./native-harness.js";

const MAX_RETAINED_RECORDS = 4096;
const MAX_RETAINED_TURNS = 128;
const MAX_RECENT_EVICTED_IDS = 4096;
const MAX_SESSION_ADOPTIONS = 16;
const SESSION_ID_PATTERN = /^[0-9a-f-]{8,64}$/iu;
const ADOPTION_CLOCK_SKEW_MS = 5_000;
const ADOPTION_RETRY_AFTER_MS = 2_000;
const MAX_ADOPTION_ATTEMPTS_TRACKED = 64;
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
  private transcriptTail: JsonlTail;
  private adoptedSessions = 0;
  private readonly adoptionAttempts = new Map<string, number>();
  private transcriptFile: string | null;
  private sessionId: string | null;
  private currentTurn: string | null = null;
  private hookIdentityConfirmed = false;
  private unconfirmedTranscriptOffset: number | null = null;
  private unconfirmedHookBoundaryEstablished = false;
  private unconfirmedHookCount = 0;
  private workingRecord: string | null = null;
  private transcriptPosition = 0;
  private evictedRecords: EvictedRecordIndex | null = null;
  private readonly recentEvictedIds = new Set<string>();
  private readonly knownTurns = new Set<string>();
  private readonly recordTurns = new Map<string, string | null>();
  private readonly recordParents = new Map<
    string,
    { parent: string | null; location: JsonlRecordLocation }
  >();
  private readonly completedTurns = new Map<string, string>();

  constructor(
    private readonly cli: ProviderNativeTerminal,
    private readonly env: NativeHarnessEnv,
    private readonly eventsFile: string | null,
    start: NativeActivityStart,
    private readonly onUnconfirmedIdentity?: (total: number) => void,
    private readonly onUnconfirmedHookIdentity?: (
      reason: "missing-session" | "foreign-session" | "unbound",
      total: number,
    ) => void,
    private readonly onSessionAdopted?: (sessionId: string) => void,
    private readonly launchedAtMs: number = Date.now(),
  ) {
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
    if (this.cli.activity?.hooks?.sessionIdField !== undefined) {
      this.unconfirmedTranscriptOffset = this.currentTranscriptSize();
      this.unconfirmedHookBoundaryEstablished = false;
    }
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
      const unconfirmedHookReasons = new Set<
        "missing-session" | "foreign-session" | "unbound"
      >();
      for (const record of this.hookTail.readRecords(this.eventsFile)) {
        if (hooks.sessionIdField !== undefined) {
          const hookSession = this.stringField(record, hooks.sessionIdField);
          let reason: "missing-session" | "foreign-session" | "unbound" | null =
            this.sessionId === null
              ? "unbound"
              : hookSession === null
                ? "missing-session"
                : hookSession !== this.sessionId
                  ? "foreign-session"
                  : null;
          if (
            reason === "foreign-session" &&
            hookSession !== null &&
            this.adoptSession(hookSession)
          ) {
            reason = null;
          }
          if (reason !== null) {
            if (
              this.hookIdentityConfirmed ||
              !this.unconfirmedHookBoundaryEstablished
            ) {
              this.unconfirmedTranscriptOffset = this.currentTranscriptSize();
              this.unconfirmedHookBoundaryEstablished = true;
            }
            this.hookIdentityConfirmed = false;
            this.unconfirmedHookCount += 1;
            unconfirmedHookReasons.add(reason);
            continue;
          }
        }
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
        const report = this.tracker.apply(signal);
        if (
          hooks.sessionIdField !== undefined &&
          (signal.state !== null ||
            (report !== null &&
              (signal.question !== undefined || signal.answered !== undefined)))
        ) {
          this.confirmHookIdentity();
        }
        push(report);
      }
      for (const reason of unconfirmedHookReasons) {
        this.onUnconfirmedHookIdentity?.(reason, this.unconfirmedHookCount);
      }
    }
    const transcript = activity.transcript;
    if (transcript === undefined) return reports;
    this.transcriptFile ??= this.findTranscript();
    if (this.transcriptFile === null) return reports;
    if (
      !this.hookIdentityConfirmed &&
      this.unconfirmedTranscriptOffset === Number.POSITIVE_INFINITY
    ) {
      this.unconfirmedTranscriptOffset =
        fileSize(this.transcriptFile) ?? Number.POSITIVE_INFINITY;
    }
    this.transcriptTail.readRecords(this.transcriptFile, (record, location) => {
      if (
        !this.hookIdentityConfirmed &&
        this.unconfirmedTranscriptOffset !== null &&
        location.offset < this.unconfirmedTranscriptOffset
      ) {
        return;
      }
      const signal = classifyTranscriptRecord(transcript, record);
      const identified = this.identifyTranscript(record, signal, location);
      const report = this.tracker.apply(identified);
      if (
        this.cli.activity?.hooks?.sessionIdField !== undefined &&
        (identified.state !== null ||
          (report !== null &&
            (identified.question !== undefined ||
              identified.answered !== undefined)))
      ) {
        this.confirmHookIdentity();
      }
      push(report);
    });
    return reports;
  }

  heartbeat(): NativeActivityReport | null {
    if (
      this.cli.activity?.hooks?.sessionIdField !== undefined &&
      !this.hookIdentityConfirmed
    ) {
      return null;
    }
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

  private currentTranscriptSize(): number {
    const file = this.transcriptFile ?? this.findTranscript();
    if (file === null) return Number.POSITIVE_INFINITY;
    return fileSize(file) ?? Number.POSITIVE_INFINITY;
  }

  private adoptSession(sessionId: string): boolean {
    if (
      this.adoptedSessions >= MAX_SESSION_ADOPTIONS ||
      !SESSION_ID_PATTERN.test(sessionId)
    ) {
      return false;
    }
    const now = Date.now();
    const previousAttempt = this.adoptionAttempts.get(sessionId);
    if (
      previousAttempt !== undefined &&
      now - previousAttempt < ADOPTION_RETRY_AFTER_MS
    ) {
      return false;
    }
    this.adoptionAttempts.set(sessionId, now);
    if (this.adoptionAttempts.size > MAX_ADOPTION_ATTEMPTS_TRACKED) {
      const oldest = this.adoptionAttempts.keys().next().value;
      if (oldest !== undefined) this.adoptionAttempts.delete(oldest);
    }
    let file: string | null;
    try {
      file = findNativeSessionFile(this.cli, this.env, sessionId);
    } catch {
      return false;
    }
    if (file === null) return false;
    let modifiedAtMs: number;
    try {
      modifiedAtMs = statSync(file).mtimeMs;
    } catch {
      return false;
    }
    if (modifiedAtMs < this.launchedAtMs - ADOPTION_CLOCK_SKEW_MS) return false;
    this.adoptedSessions += 1;
    this.sessionId = sessionId;
    this.transcriptFile = file;
    this.transcriptTail = new JsonlTail(fileSize(file) ?? 0);
    this.unconfirmedTranscriptOffset = null;
    this.unconfirmedHookBoundaryEstablished = false;
    this.currentTurn = null;
    this.workingRecord = null;
    this.onSessionAdopted?.(sessionId);
    return true;
  }

  private confirmHookIdentity(): void {
    this.hookIdentityConfirmed = true;
    this.unconfirmedTranscriptOffset = null;
    this.unconfirmedHookBoundaryEstablished = false;
  }

  private stringField(record: unknown, field: string): string | null {
    const value = readRecordField(record, field);
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private identifyTranscript(
    record: unknown,
    signal: NativeActivitySignal,
    location: JsonlRecordLocation,
  ): NativeActivitySignal {
    const identity = this.cli.activity?.transcript?.identity;
    if (identity === undefined) return signal;
    this.transcriptPosition += 1;
    const ignored = { state: null, prompt: null };
    const id = this.stringField(record, identity.recordId);
    if (id === null || this.recordTurns.has(id)) return ignored;
    if (identity.timestamp !== undefined) {
      const value = this.stringField(record, identity.timestamp);
      if (value === null || !Number.isFinite(Date.parse(value))) return ignored;
    }
    if (
      this.recentEvictedIds.has(id) ||
      (this.transcriptFile !== null &&
        this.evictedRecords?.has(id, this.transcriptFile) === true)
    ) {
      return ignored;
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
      location,
    });
    this.pruneRecords();
    if (signal.question !== undefined || signal.answered !== undefined) {
      return turn === null ||
        this.currentTurn === null ||
        this.currentTurn === turn
        ? signal
        : ignored;
    }
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
      if (record !== undefined) {
        const identity = this.cli.activity?.transcript?.identity;
        if (identity !== undefined) {
          this.evictedRecords ??= new EvictedRecordIndex(
            identity.recordId,
            this.onUnconfirmedIdentity,
          );
          this.evictedRecords.add(id, record.location);
        }
        this.recentEvictedIds.add(id);
        if (this.recentEvictedIds.size > MAX_RECENT_EVICTED_IDS) {
          const expired = this.recentEvictedIds.values().next().value;
          if (expired !== undefined) this.recentEvictedIds.delete(expired);
        }
      }
      this.recordTurns.delete(id);
      this.recordParents.delete(id);
      break;
    }
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
