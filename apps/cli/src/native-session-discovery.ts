import type { NativeSessionMatch } from "./native-harness.js";
import { permanentRefusal } from "./native-session-rebinder.js";

export type DiscoveredSessionOutcome =
  | { kind: "recorded" }
  | { code: string; kind: "refused" }
  | { kind: "retry" };

export async function recordDiscoveredSession(options: {
  currentCredential(): string | null;
  nativeSessionId: string;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
}): Promise<DiscoveredSessionOutcome> {
  const credential = options.currentCredential();
  if (credential === null) return { kind: "retry" };
  try {
    await options.recordSession({
      authorization: `Bearer ${credential}`,
      nativeSessionId: options.nativeSessionId,
    });
    return { kind: "recorded" };
  } catch (error) {
    const code = permanentRefusal(error);
    return code === null ? { kind: "retry" } : { code, kind: "refused" };
  }
}

export interface SessionDiscovererReader {
  sessionDiscovered(sessionId: string): void;
  suspend(): void;
}

function normalizeDiscoveredMatch(
  raw: string | NativeSessionMatch | null,
): NativeSessionMatch {
  if (raw === null) return { kind: "none" };
  if (typeof raw === "string") return { kind: "unique", sessionId: raw };
  return raw;
}

export function createSessionDiscoverer(options: {
  currentCredential(): string | null;
  discardUnsentReports(): void;
  find(): string | NativeSessionMatch | null;
  log(event: string, fields: Record<string, number | string | null>): void;
  now?: () => number;
  reader(): SessionDiscovererReader | null;
  recordSession(args: {
    authorization: string;
    nativeSessionId: string;
  }): Promise<unknown>;
  settleMs?: number | (() => number);
}): {
  arm(needed: boolean): void;
  discover(): Promise<void>;
  remainingSettleMs(): number;
} {
  let pending = false;
  let ambiguous = false;
  let provisional: { firstSeenAtMs: number; sessionId: string } | null = null;
  const readNow = () => (options.now ?? Date.now)();
  const readSettleMs = () =>
    typeof options.settleMs === "function"
      ? options.settleMs()
      : (options.settleMs ?? 0);
  const markAmbiguous = (count: number): void => {
    provisional = null;
    ambiguous = true;
    pending = false;
    options.log("session-discovery-ambiguous", { count });
  };
  return {
    arm(needed) {
      pending = needed;
      ambiguous = false;
      provisional = null;
    },
    remainingSettleMs() {
      if (!pending || ambiguous || provisional === null) return 0;
      const settleWindowMs = readSettleMs();
      if (settleWindowMs <= 0) return 0;
      return Math.max(
        0,
        settleWindowMs - (readNow() - provisional.firstSeenAtMs),
      );
    },
    async discover() {
      if (!pending || ambiguous) return;
      const match = normalizeDiscoveredMatch(options.find());
      if (match.kind === "ambiguous") {
        markAmbiguous(match.sessionIds.length);
        return;
      }
      if (match.kind === "none") {
        provisional = null;
        return;
      }
      const settleWindowMs = readSettleMs();
      if (settleWindowMs > 0) {
        const nowMs = readNow();
        if (provisional === null) {
          provisional = {
            firstSeenAtMs: nowMs,
            sessionId: match.sessionId,
          };
          return;
        }
        if (provisional.sessionId !== match.sessionId) {
          markAmbiguous(2);
          return;
        }
        if (nowMs - provisional.firstSeenAtMs < settleWindowMs) {
          return;
        }
      }
      const sessionId = match.sessionId;
      if (options.currentCredential() === null) return;
      pending = false;
      const outcome = await recordDiscoveredSession({
        currentCredential: options.currentCredential,
        nativeSessionId: sessionId,
        recordSession: options.recordSession,
      });
      pending = outcome.kind === "retry";
      if (outcome.kind === "recorded") {
        provisional = null;
        options.reader()?.sessionDiscovered(sessionId);
        options.log("session-discovery-recorded", { sessionId });
      }
      if (outcome.kind === "refused") {
        provisional = null;
        options.reader()?.suspend();
        options.discardUnsentReports();
        options.log("session-discovery-stopped", {
          code: outcome.code,
          sessionId,
        });
      }
    },
  };
}
