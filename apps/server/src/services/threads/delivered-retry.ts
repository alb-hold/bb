import {
  listStoredClientTurnRequestRowsByKeys,
  type DbQueryConnection,
} from "@bb/db";
import type { ClientTurnRequestId, PromptInput } from "@bb/domain";
import { parseStoredEvent } from "./thread-data.js";

interface StoredRequestInputArgs {
  input: readonly PromptInput[];
  requestId: ClientTurnRequestId;
  threadId: string;
}

function promptInputKey(input: readonly PromptInput[]): string {
  return JSON.stringify(
    input.map((part) => {
      switch (part.type) {
        case "text":
          return ["text", part.text];
        case "image":
          return ["image", part.url];
        case "localImage":
          return ["localImage", part.path];
        case "localFile":
          return ["localFile", part.path];
      }
    }),
  );
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
