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

type ClosureField = "closes" | "confirms";

function unrecognizedField(error: unknown, field: ClosureField): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 400 &&
    error.code === "invalid_request" &&
    new RegExp(`Unrecognized keys?: [^\\n]*"${field}"`, "u").test(error.message)
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
  let possiblyOpen = new Set<string>();

  const deliver = async (
    next: NativeActivityReport,
    sequence: number | null,
  ): Promise<void> => {
    const credential = options.currentCredential();
    const opened =
      next.state === "waiting" ? next.questions.map((q) => q.id) : [];
    const closes = [...possiblyOpen].filter((id) => !opened.includes(id));
    for (const id of opened) possiblyOpen.add(id);
    const sends = {
      closes: true,
      confirms: next.state !== "waiting" && next.confirms === false,
    };
    const request = (
      include: Record<ClosureField, boolean>,
    ): NativeTerminalReportActivityArgs => ({
      threadId: options.threadId,
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      state: next.state,
      ...(next.prompt === null ? {} : { prompt: next.prompt }),
      ...(next.state === "waiting" ? { questions: next.questions } : {}),
      ...(include.closes ? { closes } : {}),
      ...(include.confirms ? { confirms: false } : {}),
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
    try {
      await options.send(request(sends));
      acknowledge();
    } catch (error) {
      const unsupported: Record<ClosureField, boolean> = {
        closes: sends.closes && unrecognizedField(error, "closes"),
        confirms: sends.confirms && unrecognizedField(error, "confirms"),
      };
      if (!unsupported.closes && !unsupported.confirms) {
        keep(error);
        return;
      }
      options.log?.("activity-closure-field-rejected", {
        closes: unsupported.closes ? 1 : 0,
        confirms: unsupported.confirms ? 1 : 0,
      });
      try {
        await options.send(
          request({
            closes: sends.closes && !unsupported.closes,
            confirms: sends.confirms && !unsupported.confirms,
          }),
        );
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
