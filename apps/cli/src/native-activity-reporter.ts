import type { NativeTerminalReportActivityArgs } from "@bb/sdk";
import type { NativeActivityReport } from "./native-activity.js";

export interface NativeActivityReporter {
  report(next: NativeActivityReport | null): void;
  settled(): Promise<void>;
}

export function createNativeActivityReporter(options: {
  currentCredential(): string | null;
  send(args: NativeTerminalReportActivityArgs): Promise<unknown>;
  threadId: string;
}): NativeActivityReporter {
  let pending: Promise<void> = Promise.resolve();
  return {
    report(next) {
      if (next === null) return;
      pending = pending.then(() => {
        const credential = options.currentCredential();
        return options
          .send({
            threadId: options.threadId,
            ...(credential === null
              ? {}
              : { authorization: `Bearer ${credential}` }),
            state: next.state,
            ...(next.prompt === null ? {} : { prompt: next.prompt }),
            ...(next.state === "waiting" ? { questions: next.questions } : {}),
          })
          .then(
            () => undefined,
            () => undefined,
          );
      });
    },
    settled: () => pending,
  };
}
