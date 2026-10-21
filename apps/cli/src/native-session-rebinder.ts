import { BbHttpError } from "@bb/sdk";

export interface NativeSessionMove {
  previousSessionId: string;
  sessionId: string;
}

export interface NativeSessionRebinder {
  enqueue(move: NativeSessionMove): void;
  pending(): number;
  retry(): void;
  settled(): Promise<void>;
}

const PERMANENT_REFUSALS = new Set([
  "native_session_claimed",
  "native_session_rebind_stale",
  "native_session_already_bound",
]);

function permanentRefusal(error: unknown): string | null {
  if (
    error instanceof BbHttpError &&
    error.status === 409 &&
    error.code !== null &&
    PERMANENT_REFUSALS.has(error.code)
  ) {
    return error.code;
  }
  return null;
}

export function createNativeSessionRebinder(options: {
  currentCredential(): string | null;
  onRefused(move: NativeSessionMove, code: string): void;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
    replacesNativeSessionId: string;
  }): Promise<unknown>;
}): NativeSessionRebinder {
  const queue: NativeSessionMove[] = [];
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const credential = options.currentCredential();
      const move = queue[0];
      if (credential === null || move === undefined) return;
      try {
        await options.recordSession({
          authorization: `Bearer ${credential}`,
          nativeSessionId: move.sessionId,
          replacesNativeSessionId: move.previousSessionId,
        });
        queue.shift();
      } catch (error) {
        const code = permanentRefusal(error);
        if (code === null) return;
        queue.length = 0;
        options.onRefused(move, code);
        return;
      }
    }
  };

  const retry = (): void => {
    if (running !== null || queue.length === 0) return;
    running = drain().finally(() => {
      running = null;
    });
  };

  return {
    enqueue(move) {
      queue.push(move);
      retry();
    },
    pending: () => queue.length,
    retry,
    settled: async () => {
      while (running !== null) await running;
    },
  };
}
