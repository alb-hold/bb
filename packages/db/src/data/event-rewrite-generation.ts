import type { DbConnection } from "../connection.js";

const generationsByThreadId = new Map<string, number>();
const conversationOutlineGenerationsByThreadId = new Map<string, number>();

export function getThreadEventRewriteGeneration(threadId: string): number {
  return generationsByThreadId.get(threadId) ?? 0;
}

export function getThreadConversationOutlineRewriteGeneration(
  threadId: string,
): number {
  return conversationOutlineGenerationsByThreadId.get(threadId) ?? 0;
}

export function bumpThreadEventRewriteGeneration(threadId: string): void {
  bumpThreadEventRewriteGenerationOutsideConversationOutline(threadId);
  conversationOutlineGenerationsByThreadId.set(
    threadId,
    getThreadConversationOutlineRewriteGeneration(threadId) + 1,
  );
}

export function bumpThreadEventRewriteGenerationOutsideConversationOutline(
  threadId: string,
): void {
  generationsByThreadId.set(
    threadId,
    getThreadEventRewriteGeneration(threadId) + 1,
  );
}

export function getDatabaseDataVersion(db: DbConnection): number {
  const version: unknown = db.$client.pragma("data_version", { simple: true });
  if (typeof version !== "number") {
    throw new Error("PRAGMA data_version did not return a number");
  }
  return version;
}

const BACKGROUND_TASK_APPEND_GENERATION_LIMIT = 50_000;
const backgroundTaskAppendGenerationsByThreadId = new Map<string, number>();
let threadEventOwnershipEpoch = 0;

export function getThreadEventOwnershipEpoch(): number {
  return threadEventOwnershipEpoch;
}

export function bumpThreadEventOwnershipEpoch(): void {
  threadEventOwnershipEpoch += 1;
  backgroundTaskAppendGenerationsByThreadId.clear();
}

export function getBackgroundTaskAppendGeneration(threadId: string): number {
  return backgroundTaskAppendGenerationsByThreadId.get(threadId) ?? 0;
}

export function bumpBackgroundTaskAppendGeneration(threadId: string): void {
  const next = getBackgroundTaskAppendGeneration(threadId) + 1;
  if (
    !backgroundTaskAppendGenerationsByThreadId.has(threadId) &&
    backgroundTaskAppendGenerationsByThreadId.size >=
      BACKGROUND_TASK_APPEND_GENERATION_LIMIT
  ) {
    bumpThreadEventOwnershipEpoch();
  }
  backgroundTaskAppendGenerationsByThreadId.set(threadId, next);
}

export function getBackgroundTaskAppendGenerationCount(): number {
  return backgroundTaskAppendGenerationsByThreadId.size;
}
