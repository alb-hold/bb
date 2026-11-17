import type { QueuedMessageWaitingOn } from "./queued-message.js";

export const QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS = 6 * 60 * 60 * 1000;

export const QUEUED_MESSAGE_INBOX_WAITING_ON = {
  kind: "time",
  inbox: true,
} as const satisfies QueuedMessageWaitingOn;
