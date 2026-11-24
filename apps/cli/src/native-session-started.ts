import { permanentRefusal } from "./native-session-rebinder.js";

export interface NativeSessionStartedReporter {
  note(sessionId: string): void;
  retry(): void;
  settled(): Promise<void>;
}

export function createNativeSessionStartedReporter(options: {
  currentCredential(): string | null;
  log(event: string, fields: Record<string, number | string | null>): void;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): NativeSessionStartedReporter {
  let pendingSession: string | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let sending = false;

  const send = (): void => {
    const sessionId = pendingSession;
    const credential = options.currentCredential();
    if (sending || sessionId === null || credential === null) return;
    sending = true;
    inFlight = options
      .recordSession({
        authorization: `Bearer ${credential}`,
        nativeSessionId: sessionId,
      })
      .then(() => {
        if (pendingSession === sessionId) pendingSession = null;
      })
      .catch((error: unknown) => {
        const code = permanentRefusal(error);
        if (code === null) return;
        if (pendingSession === sessionId) pendingSession = null;
        options.log("session-started-refused", { code, sessionId });
      })
      .finally(() => {
        sending = false;
      });
  };

  return {
    note(sessionId) {
      pendingSession = sessionId;
      send();
    },
    retry: send,
    settled: () => inFlight,
  };
}
