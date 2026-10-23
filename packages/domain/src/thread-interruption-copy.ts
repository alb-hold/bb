import type { SystemThreadInterruptedReason } from "./system-message.js";

export const THREAD_INTERRUPTION_TITLE_PREFIX = "Thread interrupted because ";
export const THREAD_INTERRUPTION_RETRY_DETAIL =
  "Please retry the thread to continue.";

export type RuntimeThreadInterruptionReason =
  | SystemThreadInterruptedReason
  | "host-connection-lost";

export function threadCommandFailureCopyForInterruption(
  reason: RuntimeThreadInterruptionReason,
): { detail: string; message: string } | null {
  switch (reason) {
    case "host-removed":
    case "manual-stop":
      return null;
    case "host-daemon-restarted":
      return {
        message: `${THREAD_INTERRUPTION_TITLE_PREFIX}the host daemon disconnected`,
        detail: THREAD_INTERRUPTION_RETRY_DETAIL,
      };
    case "host-connection-lost":
      return {
        message: `${THREAD_INTERRUPTION_TITLE_PREFIX}the connection to the host was lost`,
        detail: THREAD_INTERRUPTION_RETRY_DETAIL,
      };
    case "provider-turn-idle":
      return {
        message:
          "Live runtime work failed because the provider stopped sending progress",
        detail:
          "Provider stopped sending progress while the thread was running",
      };
    default:
      return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected interruption reason: ${value}`);
}
