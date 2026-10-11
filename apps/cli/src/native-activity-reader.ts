import type { ProviderNativeTerminal } from "@bb/domain";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  fileSize,
  JsonlTail,
  NativeActivityTracker,
  type NativeActivityReport,
} from "./native-activity.js";
import {
  findNativeSessionFile,
  type NativeHarnessEnv,
} from "./native-harness.js";

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

  constructor(
    private readonly cli: ProviderNativeTerminal,
    private readonly env: NativeHarnessEnv,
    private readonly eventsFile: string | null,
    start: NativeActivityStart,
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
        push(this.tracker.apply(classifyHookRecord(hooks, record)));
      }
    }
    const transcript = activity.transcript;
    if (transcript === undefined) return reports;
    this.transcriptFile ??= this.findTranscript();
    if (this.transcriptFile === null) return reports;
    for (const record of this.transcriptTail.readRecords(this.transcriptFile)) {
      push(this.tracker.apply(classifyTranscriptRecord(transcript, record)));
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
}
