import type { NativeTerminalReportActivityArgs } from "@bb/sdk";
import type { NativeActivityReport } from "./native-activity.js";
import { permanentRefusal } from "./native-session-rebinder.js";

export interface NativeActivityReporter {
  report(
    next: NativeActivityReport | null,
    options?: { transient?: boolean },
  ): void;
  retry(): void;
  settled(): Promise<void>;
}

interface RetainedReport {
  report: NativeActivityReport;
  sequence: number;
}

export function createNativeActivityReporter(options: {
  currentCredential(): string | null;
  send(args: NativeTerminalReportActivityArgs): Promise<unknown>;
  threadId: string;
}): NativeActivityReporter {
  let pending: Promise<void> = Promise.resolve();
  let latestSequence = 0;
  let retained: RetainedReport | null = null;

  const deliver = async (
    next: NativeActivityReport,
    sequence: number | null,
  ): Promise<void> => {
    const credential = options.currentCredential();
    try {
      await options.send({
        threadId: options.threadId,
        ...(credential === null
          ? {}
          : { authorization: `Bearer ${credential}` }),
        state: next.state,
        ...(next.prompt === null ? {} : { prompt: next.prompt }),
        ...(next.state === "waiting" ? { questions: next.questions } : {}),
      });
    } catch (error) {
      if (
        sequence !== null &&
        sequence === latestSequence &&
        permanentRefusal(error) === null
      ) {
        retained = { report: next, sequence };
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
    retry() {
      const resend = retained;
      if (resend === null) return;
      retained = null;
      pending = pending.then(() => deliver(resend.report, resend.sequence));
    },
    settled: () => pending,
  };
}
