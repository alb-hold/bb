import { BbHttpError, type NativeTerminalReportActivityArgs } from "@bb/sdk";
import type { NativeActivityReport } from "./native-activity.js";
import { permanentRefusal } from "./native-session-rebinder.js";

export interface NativeActivityReporter {
  report(
    next: NativeActivityReport | null,
    options?: { transient?: boolean },
  ): void;
  retry(): void;
  discardRetained(): void;
  settled(): Promise<void>;
}

interface RetainedReport {
  report: NativeActivityReport;
  sequence: number;
}

const UNRECOGNIZED_CLOSURE_FIELD =
  /Unrecognized keys?: .*"(?:closes|confirms)"/u;

function rejectsClosureFields(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 400 &&
    error.code === "invalid_request" &&
    UNRECOGNIZED_CLOSURE_FIELD.test(error.message)
  );
}

export function createNativeActivityReporter(options: {
  currentCredential(): string | null;
  log?(event: string, fields: Record<string, number | string | null>): void;
  send(args: NativeTerminalReportActivityArgs): Promise<unknown>;
  threadId: string;
}): NativeActivityReporter {
  let pending: Promise<void> = Promise.resolve();
  let latestSequence = 0;
  let retained: RetainedReport | null = null;
  let closureSupported = true;
  let possiblyOpen: Set<string> | null = null;

  const deliver = async (
    next: NativeActivityReport,
    sequence: number | null,
  ): Promise<void> => {
    const credential = options.currentCredential();
    const opened =
      next.state === "waiting" ? next.questions.map((q) => q.id) : [];
    const closes =
      possiblyOpen === null
        ? undefined
        : [...possiblyOpen].filter((id) => !opened.includes(id));
    if (possiblyOpen !== null) {
      for (const id of opened) possiblyOpen.add(id);
    }
    const request = (
      withClosure: boolean,
    ): NativeTerminalReportActivityArgs => ({
      threadId: options.threadId,
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      state: next.state,
      ...(next.prompt === null ? {} : { prompt: next.prompt }),
      ...(next.state === "waiting" ? { questions: next.questions } : {}),
      ...(withClosure && closes !== undefined ? { closes } : {}),
      ...(withClosure && next.state !== "waiting" && next.confirms === false
        ? { confirms: false }
        : {}),
    });
    const acknowledge = (): void => {
      possiblyOpen = new Set(opened);
    };
    const keep = (error: unknown): void => {
      if (
        sequence !== null &&
        sequence === latestSequence &&
        permanentRefusal(error) === null
      ) {
        retained = { report: next, sequence };
      }
    };
    const withClosure = closureSupported;
    try {
      await options.send(request(withClosure));
      acknowledge();
    } catch (error) {
      if (!withClosure || !rejectsClosureFields(error)) {
        keep(error);
        return;
      }
      closureSupported = false;
      options.log?.("activity-closure-field-rejected", {
        closing: closes?.length ?? 0,
        status: error instanceof BbHttpError ? error.status : null,
      });
      if (closes !== undefined && closes.length > 0) return;
      try {
        await options.send(request(false));
        acknowledge();
      } catch (retryError) {
        keep(retryError);
      }
    }
  };

  return {
    report(next, reportOptions) {
      if (next === null) return;
      let sequence: number | null = null;
      if (reportOptions?.transient !== true) {
        latestSequence += 1;
        sequence = latestSequence;
        retained = null;
      }
      pending = pending.then(() => deliver(next, sequence));
    },
    discardRetained() {
      latestSequence += 1;
      retained = null;
    },
    retry() {
      const resend = retained;
      if (resend === null) return;
      retained = null;
      pending = pending.then(() => deliver(resend.report, resend.sequence));
    },
    settled: () => pending,
  };
}
