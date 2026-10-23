import { BbHttpError, type NativeTerminalReportActivityArgs } from "@bb/sdk";
import { NATIVE_TERMINAL_MAX_OPEN_QUESTIONS } from "@bb/server-contract";
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
    const openedSet = new Set(opened);
    const closes = [...possiblyOpen].filter((id) => !openedSet.has(id));
    for (const id of opened) possiblyOpen.add(id);
    const sends = {
      closes: true,
      confirms: next.state !== "waiting" && next.confirms === false,
    };
    const request = (
      closeIds: string[] | undefined,
      includeConfirms: boolean,
    ): NativeTerminalReportActivityArgs => ({
      threadId: options.threadId,
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      state: next.state,
      ...(next.prompt === null ? {} : { prompt: next.prompt }),
      ...(next.state === "waiting" ? { questions: next.questions } : {}),
      ...(closeIds === undefined ? {} : { closes: closeIds }),
      ...(includeConfirms ? { confirms: false } : {}),
    });
    const acknowledge = (closed: string[] | undefined): void => {
      if (closed === undefined) {
        possiblyOpen = new Set([...possiblyOpen, ...opened]);
        return;
      }
      for (const id of closed) {
        if (!openedSet.has(id)) possiblyOpen.delete(id);
      }
      for (const id of opened) possiblyOpen.add(id);
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
    const sendBatch = async (
      closeIds: string[],
      includeConfirms: boolean,
    ): Promise<"accepted" | "unsupported" | "failed"> => {
      try {
        await options.send(request(closeIds, includeConfirms));
        acknowledge(closeIds);
        return "accepted";
      } catch (error) {
        const unsupported: Record<ClosureField, boolean> = {
          closes: unrecognizedField(error, "closes"),
          confirms: includeConfirms && unrecognizedField(error, "confirms"),
        };
        if (unsupported.closes || unsupported.confirms) {
          options.log?.("activity-closure-field-rejected", {
            closes: unsupported.closes ? 1 : 0,
            confirms: unsupported.confirms ? 1 : 0,
          });
          try {
            await options.send(
              request(
                unsupported.closes ? undefined : closeIds,
                includeConfirms && !unsupported.confirms,
              ),
            );
            acknowledge(unsupported.closes ? undefined : closeIds);
            return unsupported.closes ? "unsupported" : "accepted";
          } catch (retryError) {
            keep(retryError);
            return "failed";
          }
        }

        if (
          closeIds.length > 0 &&
          error instanceof BbHttpError &&
          permanentRefusal(error) !== null
        ) {
          if (closeIds.length > 1) {
            for (const id of closeIds) {
              const result = await sendBatch([id], includeConfirms);
              if (result === "unsupported" || result === "failed") {
                return result;
              }
            }
            return "accepted";
          }
          try {
            await options.send(request([], includeConfirms));
            acknowledge([]);
            return "accepted";
          } catch (activityError) {
            keep(activityError);
            return "failed";
          }
        }

        keep(error);
        return "failed";
      }
    };

    for (
      let start = 0;
      start < Math.max(closes.length, 1);
      start += NATIVE_TERMINAL_MAX_OPEN_QUESTIONS
    ) {
      if (start > 0 && sequence !== null && sequence !== latestSequence) return;
      const batch = closes.slice(
        start,
        start + NATIVE_TERMINAL_MAX_OPEN_QUESTIONS,
      );
      const result = await sendBatch(batch, sends.confirms);
      if (result !== "accepted") return;
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
