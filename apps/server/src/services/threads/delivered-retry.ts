import { toRecord } from "@bb/core-ui";
import {
  hasStoredClientRequestEcho,
  listStoredClientTurnRequestRowsByKeys,
  type ClaimedQueuedThreadMessageRow,
  type DbQueryConnection,
} from "@bb/db";
import {
  clientTurnRequestIdSchema,
  type ClientTurnRequestId,
  type PromptInput,
} from "@bb/domain";
import { parseStoredEvent } from "./thread-data.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

interface StoredRequestInputArgs {
  input: readonly PromptInput[];
  requestId: ClientTurnRequestId;
  threadId: string;
}

function promptInputKey(input: readonly PromptInput[]): string {
  return JSON.stringify(input, (_key, value: unknown) => {
    const record = toRecord(value);
    if (record === null) return value;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

export function matchesStoredRequestInput(
  db: DbQueryConnection,
  args: StoredRequestInputArgs,
): boolean {
  const wanted = promptInputKey(args.input);
  return listStoredClientTurnRequestRowsByKeys(db, {
    keys: [{ threadId: args.threadId, requestId: args.requestId }],
  }).some((row) => {
    const event = parseStoredEvent(row);
    if (event.type !== "client/turn/requested") return false;
    return [event.input, ...(event.inputGroups ?? [])].some(
      (stored) => promptInputKey(stored) === wanted,
    );
  });
}

export function isDeliveredRetry(
  db: DbQueryConnection,
  args: StoredRequestInputArgs,
): boolean {
  return (
    hasStoredClientRequestEcho(db, args) && matchesStoredRequestInput(db, args)
  );
}

export function findDeliveredRetryRows(
  db: DbQueryConnection,
  rows: readonly ClaimedQueuedThreadMessageRow[],
): readonly ClaimedQueuedThreadMessageRow[] {
  return rows.filter((row) => {
    if (row.resendOfClientRequestId === null) return false;
    return isDeliveredRetry(db, {
      threadId: row.threadId,
      requestId: clientTurnRequestIdSchema.parse(row.resendOfClientRequestId),
      input: toThreadQueuedMessage(row).content,
    });
  });
}

export class DeliveredRetryDetected extends Error {
  constructor(readonly rows: readonly ClaimedQueuedThreadMessageRow[] = []) {
    super("The original request was already delivered");
    this.name = "DeliveredRetryDetected";
  }
}
