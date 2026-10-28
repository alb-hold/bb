import {
  advanceThreadPruning,
  createConnection,
  events,
  getThread,
  listEvents,
} from "@bb/db";
import { sql } from "drizzle-orm";
import { threadScope, turnScope } from "@bb/domain";
import type { ThreadEventType } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import {
  ACTIVE_THREAD_EVENT_PRUNE_SYNC_BLOCK_CAP_MS,
  maybePruneActiveThreadEventHistory,
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../../src/services/system/event-pruning.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import {
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness, withTestHarness } from "../helpers/test-app.js";

interface SeedNoiseRowsArgs {
  endingSequence: number;
  startingSequence?: number;
  threadId: string;
}

interface CreateTokenUsageDataArgs {
  modelContextWindow: number | null;
  totalTokens: number;
}

interface CreateContextWindowUsageDataArgs {
  estimated?: boolean;
  modelContextWindow: number | null;
  usedTokens: number | null;
}

function createTokenUsageData(
  args: CreateTokenUsageDataArgs,
): Record<string, unknown> {
  return {
    tokenUsage: {
      total: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: args.totalTokens,
        inputTokens: args.totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: args.modelContextWindow,
    },
  };
}

function createContextWindowUsageData(
  args: CreateContextWindowUsageDataArgs,
): Record<string, unknown> {
  return {
    contextWindowUsage: {
      usedTokens: args.usedTokens,
      modelContextWindow: args.modelContextWindow,
      estimated: args.estimated ?? false,
    },
  };
}

function listEventSequencesForType(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: { itemId?: string; threadId: string; type: string },
): number[] {
  return listEvents(harness.db, {
    threadId: args.threadId,
  })
    .filter(
      (event) =>
        event.type === args.type &&
        (args.itemId === undefined || event.itemId === args.itemId),
    )
    .map((event) => event.sequence);
}

function drainLivePruning(
  deps: Parameters<typeof pruneThreadEventHistoryBestEffort>[0],
  args: Parameters<typeof pruneThreadEventHistoryBestEffort>[1],
) {
  let totalRemoved = 0;
  let passesSinceRemoval = 0;
  for (let i = 0; i < 1000 && passesSinceRemoval < 256; i++) {
    const result = pruneThreadEventHistoryBestEffort(deps, args);
    if (result === null) throw new Error("Live cleanup failed");
    expect(result.scanned).toBeLessThanOrEqual(32);
    totalRemoved += result.totalRemoved;
    passesSinceRemoval = result.totalRemoved > 0 ? 0 : passesSinceRemoval + 1;
  }
  return { totalRemoved };
}

function seedNoiseRows(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: SeedNoiseRowsArgs,
): void {
  const startingSequence = args.startingSequence ?? 1;
  for (
    let sequence = startingSequence;
    sequence <= args.endingSequence;
    sequence += 1
  ) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: "provider-thread-1",
      sequence,
      scope: turnScope(`turn-${sequence}`),
      type: "thread/tokenUsage/updated",
      itemId: null,
      itemKind: null,
      data: createTokenUsageData({
        totalTokens: sequence,
        modelContextWindow: null,
      }),
    });
  }
}

function seedResolvedAssistantMessage(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  args: {
    completedSequence: number;
    deltaSequences: readonly number[];
    itemId: string;
    threadId: string;
    turnId?: string;
  },
): void {
  const turnId = args.turnId ?? "turn-1";
  for (const sequence of args.deltaSequences) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      sequence,
      type: "item/agentMessage/delta",
      scope: turnScope(turnId),
      itemId: args.itemId,
      itemKind: null,
      data: {
        itemId: args.itemId,
        delta: `chunk-${sequence}`,
      },
    });
  }

  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.completedSequence,
    type: "item/completed",
    scope: turnScope(turnId),
    itemId: args.itemId,
    itemKind: "agentMessage",
    data: {
      item: {
        id: args.itemId,
        type: "agentMessage",
        text: "Final answer",
      },
    },
  });
}

describe("thread event pruning", () => {
  it("yields between candidate slices and preserves each thread's deletion set", async () => {
    const scheduled: Array<() => void> = [];
    let pruneClock = 0;
    const injectedClock = () => {
      pruneClock += 4;
      return pruneClock;
    };
    const harness = await createTestAppHarness({
      activeThreadPruneRuntime: {
        now: injectedClock,
        schedule: (callback) => scheduled.push(callback),
      },
    });
    try {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const threads = Array.from({ length: 3 }, () =>
        seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "active",
        }),
      );
      for (const thread of threads) {
        harness.db.transaction(() => {
          for (let sequence = 1; sequence <= 300; sequence += 1) {
            seedStoredEvent(harness.deps, {
              threadId: thread.id,
              providerThreadId: `provider-${thread.id}`,
              sequence,
              scope: turnScope(`turn-${sequence}`),
              type: "provider/rateLimits/updated",
              itemId: null,
              itemKind: null,
              data: { rateLimits: { providerId: "codex" } },
            });
          }
        });
        seedTurnStarted(harness.deps, {
          threadId: thread.id,
          turnId: `trigger-${thread.id}`,
          providerThreadId: `provider-${thread.id}`,
          sequence: 301,
        });
        resetActiveThreadEventPruningState(harness.deps, thread.id);
      }
      const order: string[] = [];
      harness.db.run(
        sql`CREATE TABLE prune_slice_observations (thread_id TEXT NOT NULL, policy TEXT NOT NULL)`,
      );
      harness.db.run(
        sql`CREATE TRIGGER observe_prune_slices AFTER UPDATE ON thread_pruning_cursors WHEN NEW.thread_id IS NOT NULL BEGIN INSERT INTO prune_slice_observations (thread_id, policy) VALUES (NEW.thread_id, NEW.policy); END`,
      );
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents(
            threads.flatMap((thread) => [
              {
                threadId: thread.id,
                event: {
                  type: "thread/identity" as const,
                  threadId: thread.id,
                  providerThreadId: `provider-${thread.id}`,
                  scope: threadScope(),
                },
              },
              ...Array.from({ length: 250 }, (_, index) => ({
                threadId: thread.id,
                event: {
                  type: "thread/tokenUsage/updated" as const,
                  threadId: thread.id,
                  providerThreadId: `provider-${thread.id}`,
                  scope: turnScope(`trigger-${thread.id}`),
                  tokenUsage: {
                    total: {
                      totalTokens: index + 1,
                      inputTokens: index + 1,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    last: {
                      totalTokens: index + 1,
                      inputTokens: index + 1,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    modelContextWindow: 200_000,
                  },
                },
              })),
            ]),
          ),
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as {
        acceptedEvents: Array<{ sequence: number }>;
      };
      expect(responseBody.acceptedEvents).toHaveLength(753);
      expect(
        harness.db.all(sql`SELECT thread_id FROM prune_slice_observations`),
      ).toEqual([]);
      expect(scheduled).toHaveLength(0);
      for (let attempt = 0; attempt < 20 && scheduled.length === 0; attempt++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        harness.db.all(sql`SELECT thread_id FROM prune_slice_observations`),
      ).toEqual([]);
      expect(scheduled).toHaveLength(1);

      const referenceDb = createConnection(harness.db.$client.serialize());
      const referenceIds = new Map<string, string[]>();
      try {
        for (const thread of threads) {
          const completed = new Set<string>();
          for (let attempt = 0; attempt < 10_000 && completed.size < 4; attempt++) {
            const result = advanceThreadPruning(referenceDb, {
              threadId: thread.id,
            });
            if (result.action === "cycle-complete" || result.action === "thread-complete")
              completed.add(result.policy);
          }
          expect(completed.size).toBe(4);
          referenceIds.set(
            thread.id,
            listEvents(referenceDb, { threadId: thread.id })
              .map((event) => event.id)
              .sort(),
          );
        }
      } finally {
        referenceDb.$client.close();
      }

      let firstSliceSeen = false;
      let markerTask: (() => void) | undefined;
      while (scheduled.length > 0) {
        const callback = scheduled.shift();
        const before = harness.db.all(
          sql`SELECT thread_id, policy FROM prune_slice_observations`,
        ).length;
        const startedAt = injectedClock();
        callback?.();
        const syncBlockMs = injectedClock() - startedAt;
        expect(syncBlockMs).toBeLessThanOrEqual(
          ACTIVE_THREAD_EVENT_PRUNE_SYNC_BLOCK_CAP_MS,
        );
        const observations = harness.db.all(
          sql`SELECT thread_id, policy FROM prune_slice_observations`,
        ) as Array<{ policy: string; thread_id: string }>;
        if (observations.length > before) {
          expect(observations.length - before).toBeLessThanOrEqual(5);
          const latest = observations.at(-1);
          expect(latest).toBeDefined();
          order.push(`slice:${latest?.thread_id}`);
        } else {
          expect(callback).toBe(markerTask);
        }
        if (!firstSliceSeen) {
          firstSliceSeen = true;
          markerTask = () => order.push("marker");
          scheduled.unshift(markerTask);
        }
      }
      const firstCandidateIndex = order.findIndex((entry) => entry.startsWith("slice:"));
      expect(order[firstCandidateIndex + 1]).toBe("marker");
      expect(order[firstCandidateIndex + 2]).toBe(`slice:${threads[1]?.id}`);
      expect(
        new Set(
          (
            harness.db.all(
              sql`SELECT DISTINCT thread_id FROM prune_slice_observations`,
            ) as Array<{ thread_id: string }>
          ).map((row) => row.thread_id),
        ),
      ).toEqual(new Set(threads.map((thread) => thread.id)));
      for (const thread of threads) {
        expect(
          listEvents(harness.db, { threadId: thread.id })
            .map((event) => event.id)
            .sort(),
        ).toEqual(referenceIds.get(thread.id));
        resetActiveThreadEventPruningState(harness.deps, thread.id);
      }
    } finally {
      await harness.cleanup();
    }
  }, 60_000);

  it("prunes idle-thread noise rows and resolved item deltas", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [306, 307, 308],
        completedSequence: 309,
      });

      const result = drainLivePruning(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        totalRemoved: 10,
      });
      drainLivePruning(harness.deps, { threadId: thread.id, mode: "idle" });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(9);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([306]);
    });
  });

  it("preserves context window usage when idle pruning removes old context-usage rows", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      for (let sequence = 1; sequence <= 305; sequence += 1) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          sequence,
          scope: turnScope(`turn-${sequence}`),
          type: "thread/contextWindowUsage/updated",
          itemId: null,
          itemKind: null,
          data: createContextWindowUsageData({
            usedTokens: sequence,
            modelContextWindow: sequence === 1 ? 200_000 : null,
            estimated: sequence !== 1,
          }),
        });
      }

      const result = drainLivePruning(harness.deps, {
        mode: "idle",
        threadId: thread.id,
      });
      const timeline = buildThreadTimelineWithProfile(harness.db, thread, {
        completedTurnDisplay: "collapse",
        eventBudget: 1_000_000,
        includeClearedContextHistory: false,
        includeDiagnosticOperations: true,
        compactionOfferEnabled: false,
        summarizeShellCommands: true,
        maxInlineOutputChars: null,
        maxSeq: 0,
        page: {
          kind: "latest",
          segmentLimit: Number.MAX_SAFE_INTEGER,
        },
      }).response;

      expect(result.totalRemoved).toBe(3);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/contextWindowUsage/updated",
        }),
      ).toEqual([1, ...Array.from({ length: 301 }, (_, index) => index + 5)]);
      expect(timeline.contextWindowUsage).toEqual({
        usedTokens: 305,
        modelContextWindow: 200_000,
        estimated: true,
      });
    });
  });

  it("prunes thread history when turn completion returns the thread to idle", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 305,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 306,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [307, 308],
        completedSequence: 309,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 310,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        status: "completed",
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      drainLivePruning(harness.deps, { threadId: thread.id, mode: "idle" });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(10);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([307]);
    });
  });

  it("identifies root completions even when the thread is already settled", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        data: {
          status: "completed",
        },
      });

      const result = applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        status: "completed",
      });

      expect(result.isRootTurnCompletion).toBe(true);
      expect(result.nextStatus).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("prunes thread history on archive using the same usage retention rule", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 130,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-1",
        deltaSequences: [131, 132],
        completedSequence: 133,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      drainLivePruning(harness.deps, { threadId: thread.id, mode: "archived" });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(13);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
        }),
      ).toEqual([131]);
    });
  });

  it("notifies only after a committed live advance and reports its bounded work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      for (let sequence = 1; sequence <= 100; sequence++)
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-thread",
          sequence,
          scope: turnScope("turn"),
          type: "provider/rateLimits/updated",
          itemId: null,
          itemKind: null,
          data: {},
        });
      const notify = vi
        .spyOn(harness.deps.hub, "notifyThread")
        .mockImplementation(() => {});
      const first = pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(first).toMatchObject({
        policy: "rate-limits",
        scanned: 32,
        totalRemoved: 32,
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(thread.id, [
        "history-compacted",
      ]);
      const second = pruneThreadEventHistoryBestEffort(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(second).toMatchObject({ policy: "usage", totalRemoved: 0 });
      expect(notify).toHaveBeenCalledTimes(1);
      notify.mockRestore();
    });
  });

  it("logs and returns null when best-effort pruning cannot run", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const loggerWarn = vi.fn();
      harness.deps.logger.warn = loggerWarn;

      harness.db.$client.close();

      expect(
        pruneThreadEventHistoryBestEffort(harness.deps, {
          mode: "idle",
          threadId: thread.id,
        }),
      ).toBeNull();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
        }),
        "Failed to prune thread event history",
      );
    });
  });

  it("prunes active-thread noise rows after ingest without dropping unresolved deltas", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      seedNoiseRows(harness, {
        threadId: thread.id,
        endingSequence: 1_000,
      });
      seedResolvedAssistantMessage(harness, {
        threadId: thread.id,
        itemId: "msg-completed",
        deltaSequences: [1_001, 1_002],
        completedSequence: 1_003,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        scope: turnScope("turn-1"),
        sequence: 1_006,
        type: "turn/started",
        providerThreadId: "provider-thread-1",
        itemId: null,
        itemKind: null,
        data: {
          providerThreadId: "provider-thread-1",
        },
      });
      for (const sequence of [1_004, 1_005]) {
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          scope: turnScope("turn-active"),
          sequence,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
          itemKind: null,
          data: {
            itemId: "msg-active",
            delta: `chunk-${sequence}`,
          },
        });
      }

      resetActiveThreadEventPruningState(harness.deps, thread.id);
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            createTestDaemonEventEnvelope({
              event: {
                type: "thread/tokenUsage/updated",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                scope: turnScope("turn-1"),
                tokenUsage: {
                  total: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  last: {
                    totalTokens: 1,
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                  modelContextWindow: 200_000,
                },
              },
            }),
          ]),
        }),
      });

      expect(response.status).toBe(200);
      drainLivePruning(harness.deps, {
        threadId: thread.id,
        mode: "active",
      });
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "thread/tokenUsage/updated",
        }).at(0),
      ).toBe(7);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-completed",
        }),
      ).toEqual([1_001]);
      expect(
        listEventSequencesForType(harness, {
          threadId: thread.id,
          type: "item/agentMessage/delta",
          itemId: "msg-active",
        }),
      ).toEqual([1_004, 1_005]);
    });
  });

  it("sends the event response before deferred active pruning deletes rows", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      harness.db.transaction(() => {
        for (let sequence = 1; sequence <= 1_300; sequence += 1) {
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "provider-thread-1",
            sequence,
            scope: turnScope(`turn-${sequence}`),
            type: "provider/rateLimits/updated",
            itemId: null,
            itemKind: null,
            data: { rateLimits: { providerId: "codex" } },
          });
        }
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "trigger-1",
        providerThreadId: "provider-thread-1",
        sequence: 1_301,
      });
      harness.db.run(
        sql`CREATE TABLE prune_delete_observations (event_id TEXT NOT NULL)`,
      );
      harness.db.run(
        sql`CREATE TRIGGER observe_prune_deletes AFTER DELETE ON events BEGIN INSERT INTO prune_delete_observations (event_id) VALUES (OLD.id); END`,
      );
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "thread/identity",
                threadId: thread.id,
                providerThreadId: "provider-thread-1",
                scope: threadScope(),
              },
            },
            ...Array.from({ length: 250 }, (_, index) => {
              const sequence = index + 1;
              return createTestDaemonEventEnvelope({
                event: {
                  type: "thread/tokenUsage/updated",
                  threadId: thread.id,
                  providerThreadId: "provider-thread-1",
                  scope: turnScope("trigger-1"),
                  tokenUsage: {
                    total: {
                      totalTokens: sequence,
                      inputTokens: sequence,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    last: {
                      totalTokens: sequence,
                      inputTokens: sequence,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    modelContextWindow: 200_000,
                  },
                },
              });
            }),
          ]),
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as {
        acceptedEvents: Array<{ sequence: number }>;
      };
      expect(responseBody.acceptedEvents).toHaveLength(251);
      expect(responseBody.acceptedEvents[0]?.sequence).toBeGreaterThan(250);
      expect(
        harness.db.all(sql`SELECT event_id FROM prune_delete_observations`),
      ).toEqual([]);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          harness.db.all(sql`SELECT event_id FROM prune_delete_observations`)
            .length > 0
        )
          break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(
        harness.db.all(
          sql`SELECT policy FROM thread_pruning_cursors WHERE scope = ${thread.id}`,
        ),
      ).not.toEqual([]);
      expect(
        harness.db.all(sql`SELECT event_id FROM prune_delete_observations`)
          .length,
      ).toBeGreaterThan(0);
      resetActiveThreadEventPruningState(harness.deps, thread.id);
    });
  });

  it("stops active pruning after one batch when the injected clock reaches the budget", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      let reads = 0;
      const scheduled: Array<() => void> = [];
      const now = () => (reads++ === 0 ? 0 : 101);
      const result = maybePruneActiveThreadEventHistory(harness.deps, {
        latestPrunableSequence: 300,
        threadId: thread.id,
        now,
        schedule: (callback) => scheduled.push(callback),
      });
      expect(result).toBe(true);
      expect(scheduled).toHaveLength(1);
      expect(
        harness.db.all(
          sql`SELECT policy FROM thread_pruning_cursors WHERE scope = ${thread.id}`,
        ),
      ).toHaveLength(0);
      scheduled.shift()?.();
      expect(
        harness.db.all(
          sql`SELECT policy FROM thread_pruning_cursors WHERE scope = ${thread.id}`,
        ),
      ).toHaveLength(1);
      resetActiveThreadEventPruningState(harness.deps, thread.id);
    });
  });

  it("runs an event-loop task between active pruning slices", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });
      seedNoiseRows(harness, { endingSequence: 300, threadId: thread.id });
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      const scheduled: Array<() => void> = [];
      const order: string[] = [];
      let scheduleCount = 0;
      let clockReads = 0;
      const schedule = (callback: () => void) => {
        scheduleCount += 1;
        if (scheduleCount === 1) scheduled.push(() => order.push("marker"));
        scheduled.push(() => {
          callback();
          order.push("slice");
        });
      };
      const result = maybePruneActiveThreadEventHistory(harness.deps, {
        latestPrunableSequence: 300,
        now: () => (clockReads++ % 2 === 0 ? 0 : 101),
        schedule,
        threadId: thread.id,
      });
      expect(result).toBe(true);
      expect(scheduleCount).toBe(1);
      scheduled.shift()?.();
      expect(order).toEqual(["marker"]);
      scheduled.shift()?.();
      expect(order).toEqual(["marker", "slice"]);
      expect(scheduleCount).toBe(2);
      resetActiveThreadEventPruningState(harness.deps, thread.id);
    });
  });

  it("skips a second active pruning trigger while its chain is pending", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });
      seedNoiseRows(harness, { endingSequence: 300, threadId: thread.id });
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      const scheduled: Array<() => void> = [];
      let clockReads = 0;
      let throttleTime = 50_000;
      const first = maybePruneActiveThreadEventHistory(harness.deps, {
        latestPrunableSequence: 300,
        now: () => (clockReads++ % 2 === 0 ? 0 : 101),
        schedule: (callback) => scheduled.push(callback),
        threadId: thread.id,
        throttleNow: () => throttleTime,
      });
      expect(first).toBe(true);
      expect(scheduled).toHaveLength(1);
      throttleTime += 30_001;
      const second = maybePruneActiveThreadEventHistory(harness.deps, {
        latestPrunableSequence: 600,
        now: () => (clockReads++ % 2 === 0 ? 0 : 101),
        schedule: (callback) => scheduled.push(callback),
        threadId: thread.id,
        throttleNow: () => throttleTime,
      });
      expect(second).toBe(false);
      expect(scheduled).toHaveLength(1);
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      scheduled.shift()?.();
      expect(scheduled).toHaveLength(0);
    });
  });

  it("continues active pruning through the scoped policy cycle when the clock does not advance", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });
      resetActiveThreadEventPruningState(harness.deps, thread.id);
      const scheduled: Array<() => void> = [];
      const result = maybePruneActiveThreadEventHistory(harness.deps, {
        latestPrunableSequence: 300,
        threadId: thread.id,
        now: () => 0,
        schedule: (callback) => scheduled.push(callback),
      });
      expect(result).toBe(true);
      while (scheduled.length > 0) scheduled.shift()?.();
      expect(
        harness.db.all(
          sql`SELECT policy FROM thread_pruning_cursors WHERE scope = ${thread.id}`,
        ),
      ).toHaveLength(4);
      resetActiveThreadEventPruningState(harness.deps, thread.id);
    });
  });

  it("preserves the eventual active-pruning deletion set across budgeted slices", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });
      harness.db
        .insert(events)
        .values(
          Array.from({ length: 1_400 }, (_, index) => {
            const sequence = index + 1;
            const type: ThreadEventType =
              sequence <= 400
                ? sequence % 2 === 0
                  ? "thread/tokenUsage/updated"
                  : "turn/diff/updated"
                : "provider/warning";
            return {
              id: `${thread.id}-${sequence}`,
              threadId: thread.id,
              sequence,
              scopeKind: "turn" as const,
              turnId: `turn-${sequence}`,
              type,
              data: JSON.stringify(
                type === "thread/tokenUsage/updated"
                  ? createTokenUsageData({
                      totalTokens: sequence,
                      modelContextWindow: null,
                    })
                  : { marker: sequence },
              ),
              createdAt: sequence,
            };
          }),
        )
        .run();
      const legacyDb = createConnection(harness.db.$client.serialize());
      const baseline = [
        ...listEvents(legacyDb, { threadId: thread.id }).map(
          (event) => event.id,
        ),
      ].sort();
      try {
        const completed = new Set<string>();
        for (let i = 0; i < 10_000 && completed.size < 4; i += 1) {
          const result = advanceThreadPruning(legacyDb, {
            threadId: thread.id,
          });
          if (
            result.action === "cycle-complete" ||
            result.action === "thread-complete"
          )
            completed.add(result.policy);
        }
        expect(completed.size).toBe(4);
        const legacyIds = listEvents(legacyDb, { threadId: thread.id })
          .map((event) => event.id)
          .sort();
        expect(legacyIds.length).toBeLessThan(baseline.length);

        resetActiveThreadEventPruningState(harness.deps, thread.id);
        const scheduledSlices: Array<() => void> = [];
        let clockReads = 0;
        const enqueued = maybePruneActiveThreadEventHistory(
          harness.deps,
          {
            latestPrunableSequence: 1_400,
            threadId: thread.id,
            now: () => {
              const sliceRead = clockReads++ % 6;
              return sliceRead === 5 ? 101 : 0;
            },
            schedule: (callback) => scheduledSlices.push(callback),
          },
        );
        expect(enqueued).toBe(true);
        expect(scheduledSlices).toHaveLength(1);
        for (let slice = 0; slice < 10_000 && scheduledSlices.length > 0; slice++)
          scheduledSlices.shift()?.();
        expect(scheduledSlices).toHaveLength(0);
        const budgetedIds = listEvents(harness.db, { threadId: thread.id })
          .map((event) => event.id)
          .sort();
        expect(budgetedIds).toEqual(legacyIds);
        resetActiveThreadEventPruningState(harness.deps, thread.id);
      } finally {
        legacyDb.$client.close();
      }
      expect(baseline.length).toBeGreaterThan(1_000);
    });
  });
});
