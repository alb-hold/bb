import type { ThreadTimelineResponse, TimelinePageMetadata } from "./threads.js";

export const THREAD_TIMELINE_WINDOW_FIELD_KEYS = [
  "contextBoundarySeq",
  "completedTurnDisplay",
  "activePromptMode",
  "activeThinking",
  "activeWorkflows",
  "activeBackgroundCommands",
  "pendingTodos",
  "extensionStates",
  "providerCommands",
  "sessionOptions",
  "modelFallback",
] as const satisfies readonly (keyof ThreadTimelineResponse)[];

export const TIMELINE_PAGE_FIELD_KEYS = [
  "returnedSegmentCount",
  "olderCursor",
  "historySnapshot",
  "olderRowsSourceSeqEnd",
] as const satisfies readonly (keyof TimelinePageMetadata)[];
