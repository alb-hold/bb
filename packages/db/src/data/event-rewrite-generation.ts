import type { DbConnection, DbQueryConnection } from "../connection.js";
import { deleteThreadConversationOutlineRecord } from "./thread-conversation-outlines.js";

const THREAD_REWRITE_GENERATION_LIMIT = 4_096;

class ThreadRewriteGenerations {
  private readonly entries = new Map<string, number>();
  private floor = 0;
  private highest = 0;

  get(threadId: string): number {
    return this.entries.get(threadId) ?? this.floor;
  }

  bump(threadId: string): void {
    if (
      this.entries.size >= THREAD_REWRITE_GENERATION_LIMIT &&
      !this.entries.has(threadId)
    ) {
      this.clear();
    }
    const generation = this.get(threadId) + 1;
    this.entries.set(threadId, generation);
    this.highest = Math.max(this.highest, generation);
  }

  clear(): void {
    this.highest += 1;
    this.floor = this.highest;
    this.entries.clear();
  }
}

const eventRewriteGenerations = new ThreadRewriteGenerations();
const conversationOutlineRewriteGenerations = new ThreadRewriteGenerations();

export function getThreadEventRewriteGeneration(threadId: string): number {
  return eventRewriteGenerations.get(threadId);
}

export function getThreadConversationOutlineRewriteGeneration(
  threadId: string,
): number {
  return conversationOutlineRewriteGenerations.get(threadId);
}

export function bumpThreadEventRewriteGeneration(
  db: DbQueryConnection,
  threadId: string,
): void {
  deleteThreadConversationOutlineRecord(db, threadId);
  bumpThreadEventRewriteGenerationOutsideConversationOutline(threadId);
  conversationOutlineRewriteGenerations.bump(threadId);
}

export function bumpThreadEventRewriteGenerationOutsideConversationOutline(
  threadId: string,
): void {
  eventRewriteGenerations.bump(threadId);
}

export function forgetThreadEventRewriteGenerations(): void {
  eventRewriteGenerations.clear();
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
