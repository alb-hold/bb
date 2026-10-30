import { BbHttpError, type NativeTerminalReportActivityArgs } from "@bb/sdk";
import { NATIVE_TERMINAL_MAX_OPEN_QUESTIONS } from "@bb/server-contract";
import type { NativeActivityReport } from "./native-activity.js";
import { nativeToolCredentialFingerprint } from "./native-holder.js";
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
  blockedReason?: "unsupported_closes" | "unsupported_confirms";
  report: NativeActivityReport;
  sequence: number;
}

type ClosureField = "closes" | "confirms";

const CREDENTIAL_REFUSAL_LOG_INTERVAL_MS = 10 * 60_000;
const ACTIVITY_REPORT_TIMEOUT_MS = 10_000;

function credentialRefused(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 401 &&
    error.code === "native_terminal_credential_invalid"
  );
}

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
  now?(): number;
  requestTimeoutMs?: number;
  send(args: NativeTerminalReportActivityArgs): Promise<unknown>;
  threadId: string;
}): NativeActivityReporter {
  let pending: Promise<void> = Promise.resolve();
  let latestSequence = 0;
  let retained: RetainedReport | null = null;
  let possiblyOpen = new Set<string>();
  let closesSupported = true;
  let refused = 0;
  let refusalLoggedAt: number | null = null;
  const now = options.now ?? Date.now;

  const noteRefusal = (error: unknown, credential: string | null): void => {
    if (!credentialRefused(error)) return;
    refused += 1;
    const at = now();
    if (
      refusalLoggedAt !== null &&
      at - refusalLoggedAt < CREDENTIAL_REFUSAL_LOG_INTERVAL_MS
    ) {
      return;
    }
    refusalLoggedAt = at;
    options.log?.("activity-credential-rejected", {
      fingerprint:
        credential === null
          ? null
          : nativeToolCredentialFingerprint(credential),
      rejected: refused,
    });
  };

  const noteAccepted = (credential: string | null): void => {
    if (refused === 0) return;
    options.log?.("activity-credential-accepted", {
      afterRejected: refused,
      fingerprint:
        credential === null
          ? null
          : nativeToolCredentialFingerprint(credential),
    });
    refused = 0;
    refusalLoggedAt = null;
  };

  const deliver = async (
    next: NativeActivityReport,
    sequence: number | null,
  ): Promise<void> => {
    const credential = options.currentCredential();
    const opened =
      next.state === "waiting" ? next.questions.map((q) => q.id) : [];
    const openedSet = new Set(opened);
    const closes = closesSupported
      ? [...possiblyOpen].filter((id) => !openedSet.has(id))
      : [];
    if (closesSupported) {
      for (const id of opened) possiblyOpen.add(id);
    } else {
      possiblyOpen.clear();
    }
    const sends = {
      closes: true,
      confirms: next.state !== "waiting" && next.confirms === false,
    };
    const request = (
      closeIds: string[],
      includeConfirms: boolean,
      includeCloses: boolean,
    ): NativeTerminalReportActivityArgs => ({
      signal: AbortSignal.timeout(
        options.requestTimeoutMs ?? ACTIVITY_REPORT_TIMEOUT_MS,
      ),
      threadId: options.threadId,
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      state: next.state,
      ...(next.state === "waiting" || next.lastAssistantText === undefined
        ? {}
        : { lastAssistantText: next.lastAssistantText }),
      ...(next.prompt === null ? {} : { prompt: next.prompt }),
      ...(next.state === "waiting" ? { questions: next.questions } : {}),
      ...(includeCloses ? { closes: closeIds } : {}),
      ...(includeConfirms ? { confirms: false } : {}),
    });
    const acknowledge = (closed: string[]): void => {
      if (!closesSupported) {
        possiblyOpen.clear();
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
    const keepBlocked = (
      blockedReason: RetainedReport["blockedReason"],
    ): void => {
      if (sequence !== null && sequence === latestSequence) {
        retained = {
          blockedReason,
          report: next,
          sequence,
        };
      }
    };
    const sendBatch = async (
      closeIds: string[],
      includeConfirms: boolean,
      includeCloses: boolean,
    ): Promise<"accepted" | "failed"> => {
      try {
        await options.send(request(closeIds, includeConfirms, includeCloses));
        noteAccepted(credential);
        acknowledge(closeIds);
        return "accepted";
      } catch (error) {
        noteRefusal(error, credential);
        const unsupported: Record<ClosureField, boolean> = {
          closes: includeCloses && unrecognizedField(error, "closes"),
          confirms: includeConfirms && unrecognizedField(error, "confirms"),
        };
        if (unsupported.closes) {
          closesSupported = false;
          options.log?.("activity-closure-field-rejected", {
            closes: 1,
            confirms: 0,
          });
        }
        if (unsupported.confirms) {
          options.log?.("activity-confirmation-fallback-skipped", {
            confirms: 1,
            reason: "legacy_server_defaults_true",
          });
          keepBlocked("unsupported_confirms");
          return "failed";
        }
        if (unsupported.closes) {
          options.log?.("activity-closure-fallback-omitted", {
            closes: closeIds.length,
          });
          try {
            await options.send(request(closeIds, includeConfirms, false));
            noteAccepted(credential);
            acknowledge(closeIds);
            return "accepted";
          } catch (fallbackError) {
            noteRefusal(fallbackError, credential);
            if (
              includeConfirms &&
              unrecognizedField(fallbackError, "confirms")
            ) {
              options.log?.("activity-confirmation-fallback-skipped", {
                confirms: 1,
                reason: "legacy_server_defaults_true",
              });
              keepBlocked("unsupported_confirms");
              return "failed";
            }
            keep(fallbackError);
            return "failed";
          }
        }

        if (
          closeIds.length > 0 &&
          error instanceof BbHttpError &&
          permanentRefusal(error) !== null
        ) {
          if (closeIds.length > 1) {
            let failed = false;
            for (const id of closeIds) {
              const result = await sendBatch(
                [id],
                includeConfirms,
                includeCloses,
              );
              if (result === "failed") failed = true;
            }
            return failed ? "failed" : "accepted";
          }
          options.log?.("activity-closure-fallback-skipped", {
            closes: closeIds.length,
            reason: "server_rejected_close",
          });
          keepBlocked("unsupported_closes");
          return "failed";
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
      const batch = closes.slice(
        start,
        start + NATIVE_TERMINAL_MAX_OPEN_QUESTIONS,
      );
      const result = await sendBatch(batch, sends.confirms, closesSupported);
      if (result === "failed") return;
      if (!closesSupported) return;
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
      if (resend === null || resend.blockedReason !== undefined) {
        return;
      }
      retained = null;
      pending = pending.then(() => deliver(resend.report, resend.sequence));
    },
    settled: () => pending,
  };
}
