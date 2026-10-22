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

const UNRECOGNIZED_CONFIRMS = /Unrecognized keys?: .*"confirms"/u;

function rejectsConfirmsField(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 400 &&
    error.code === "invalid_request" &&
    UNRECOGNIZED_CONFIRMS.test(error.message)
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
  let confirmsRejected = false;

  const deliver = async (
    next: NativeActivityReport,
    sequence: number | null,
  ): Promise<void> => {
    const credential = options.currentCredential();
    const request = (
      withMarker: boolean,
    ): NativeTerminalReportActivityArgs => ({
      threadId: options.threadId,
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      state: next.state,
      ...(next.prompt === null ? {} : { prompt: next.prompt }),
      ...(next.state === "waiting" ? { questions: next.questions } : {}),
      ...(withMarker ? { confirms: false } : {}),
    });
    const keep = (error: unknown): void => {
      if (
        sequence !== null &&
        sequence === latestSequence &&
        permanentRefusal(error) === null
      ) {
        retained = { report: next, sequence };
      }
    };
    const marked =
      next.state !== "waiting" && next.confirms === false && !confirmsRejected;
    try {
      await options.send(request(marked));
    } catch (error) {
      if (!marked || !rejectsConfirmsField(error)) {
        keep(error);
        return;
      }
      confirmsRejected = true;
      options.log?.("activity-confirms-field-rejected", {
        status: error instanceof BbHttpError ? error.status : null,
      });
      try {
        await options.send(request(false));
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
