import type { ThreadOpenSkipReason } from "@bb/server-contract";
import { resolveContextThreadId } from "./context-env.js";

export const ALL_CLIENTS_OPTION_DESCRIPTION =
  "Send to every open bb app client instead of only clients viewing this thread";

export const SKIP_REASON_MESSAGES: Record<ThreadOpenSkipReason, string> = {
  no_caller_thread:
    "Not run from a bb thread (BB_THREAD_ID is unset), so no open bb app client belongs to the caller; nothing was sent. Pass --all to send to every open bb app client",
  no_client_viewing_caller_thread:
    "No open bb app client is viewing this thread; nothing was sent. Pass --all to send to every open bb app client",
};

export interface OpenDeliveryOptions {
  all?: boolean;
}

export function openDeliveryScope(opts: OpenDeliveryOptions): {
  all?: boolean;
  callerThreadId?: string;
} {
  if (opts.all === true) return { all: true };
  const callerThreadId = resolveContextThreadId();
  return callerThreadId === undefined ? {} : { callerThreadId };
}
