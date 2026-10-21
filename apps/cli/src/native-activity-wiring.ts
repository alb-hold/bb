import { BbHttpError } from "@bb/sdk";
import type { NativeActivityReport } from "./native-activity.js";
import { createNativeSessionRebinder } from "./native-session-rebinder.js";

export interface NativeActivityWiring {
  onCredentialChanged(): void;
  onHeartbeatTick(): void;
  onSessionAdopted(adoptedSessionId: string, previousSessionId: string): void;
  settled(): Promise<void>;
}

export function createNativeActivityWiring(options: {
  currentCredential(): string | null;
  log(event: string, fields: Record<string, number | string | null>): void;
  reader(): {
    heartbeat(): NativeActivityReport | null;
    suspend(): void;
  } | null;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
    replacesNativeSessionId: string;
  }): Promise<unknown>;
  report(next: NativeActivityReport | null): void;
}): NativeActivityWiring {
  const rebinder = createNativeSessionRebinder({
    currentCredential: options.currentCredential,
    onRefused: (move, code) => {
      options.reader()?.suspend();
      options.log("activity-session-rebind-refused", {
        code,
        sessionId: move.sessionId,
      });
    },
    recordSession: async (args) => {
      try {
        return await options.recordSession(args);
      } catch (error) {
        options.log("activity-session-rebind-deferred", {
          code: error instanceof BbHttpError ? error.code : null,
          sessionId: args.nativeSessionId,
          status: error instanceof BbHttpError ? error.status : null,
        });
        throw error;
      }
    },
  });
  const heartbeat = (): void => {
    options.report(options.reader()?.heartbeat() ?? null);
  };
  return {
    onCredentialChanged: () => {
      rebinder.retry();
      heartbeat();
    },
    onHeartbeatTick: () => {
      rebinder.retry();
      heartbeat();
    },
    onSessionAdopted: (adoptedSessionId, previousSessionId) => {
      options.log("activity-session-adopted", {
        previousSessionId,
        sessionId: adoptedSessionId,
      });
      rebinder.enqueue({ previousSessionId, sessionId: adoptedSessionId });
    },
    settled: () => rebinder.settled(),
  };
}
