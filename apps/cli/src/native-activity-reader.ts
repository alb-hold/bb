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
  type NativeHarnessSession,
} from "./native-harness.js";

export class NativeActivityReader {
  private readonly tracker = new NativeActivityTracker();
  private readonly hookTail = new JsonlTail(0);
  private readonly transcriptTail: JsonlTail | null;
  private transcriptFile: string | null;
  private sessionId: string | null;

  constructor(
    private readonly cli: ProviderNativeTerminal,
    private readonly env: NativeHarnessEnv,
    private readonly eventsFile: string | null,
    session: NativeHarnessSession,
    measure: (filePath: string) => number | null = fileSize,
  ) {
    this.sessionId = session.kind === "discover" ? null : session.id;
    this.transcriptFile = this.findTranscript();
    if (session.kind !== "resume") {
      this.transcriptTail = new JsonlTail(0);
    } else {
      const baseline =
        this.transcriptFile === null ? null : measure(this.transcriptFile);
      this.transcriptTail = baseline === null ? null : new JsonlTail(baseline);
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
    if (transcript === undefined || this.transcriptTail === null) {
      return reports;
    }
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
