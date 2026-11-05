import {
  getThreadRowState,
  listActiveBackgroundTaskCountsByThreadIds,
  listQueuedThreadMessageCountsByThreadIds,
} from "@bb/db";
import {
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@bb/client-core";
import {
  getThreadPromptBannerActivity,
  toThreadListEntryResponses,
} from "../../src/services/threads/thread-runtime-display.js";

export function toThreadListEntryResponsesForTest(
  deps: Parameters<typeof toThreadListEntryResponses>[0],
  args: Omit<Parameters<typeof toThreadListEntryResponses>[1], "scope">,
) {
  const now = args.now ?? Date.now();
  const entries = toThreadListEntryResponses(deps, {
    ...args,
    now,
    scope: { kind: "ids", ids: args.threads.map((thread) => thread.id) },
  });
  const backgroundByThreadId = new Map(
    listActiveBackgroundTaskCountsByThreadIds(deps.db, {
      threadIds: args.threads.map((thread) => thread.id),
    }).map((row) => [row.threadId, row]),
  );
  const queuedByThreadId = new Map(
    listQueuedThreadMessageCountsByThreadIds(deps.db, {
      threadIds: args.threads.map((thread) => thread.id),
    }).map((row) => [row.threadId, row]),
  );
  const promptBannerByThreadId = new Map(
    args.threads.map((thread) => [
      thread.id,
      getThreadPromptBannerActivity(deps, thread),
    ]),
  );
  const rowStateByThreadId = new Map(
    args.threads.map((thread) => [
      thread.id,
      getThreadRowState(deps.db, thread.id, now),
    ]),
  );
  return entries.map((entry) => {
    const background = backgroundByThreadId.get(entry.id);
    const promptBanner = promptBannerByThreadId.get(entry.id);
    const queued = queuedByThreadId.get(entry.id);
    const withLegacyEnrichment = {
      ...entry,
      activity: {
        activeBackgroundAgentCount: background?.activeBackgroundAgentCount ?? 0,
        activeBackgroundCommandCount:
          background?.activeBackgroundCommandCount ?? 0,
        activeGoalCount: promptBanner?.activeGoalCount ?? 0,
        activePlanModeCount: promptBanner?.activePlanModeCount ?? 0,
        activeWorkflowCount: background?.activeWorkflowCount ?? 0,
      },
      queuedWork:
        queued === undefined || queued.queuedMessageCount === 0
          ? ("none" as const)
          : queued.failedQueuedMessageCount > 0
            ? ("failed" as const)
            : ("waiting" as const),
      rowState: rowStateByThreadId.get(entry.id) ?? {
        statuses: {},
        progress: null,
      },
    };
    return {
      ...withLegacyEnrichment,
      listIndicator: resolveThreadListIndicator(
        threadListIndicatorStateForThread(withLegacyEnrichment, false, now),
      ),
    };
  });
}
