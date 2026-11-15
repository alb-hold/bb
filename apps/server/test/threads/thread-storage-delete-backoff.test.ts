import { setTimeout as sleep } from "node:timers/promises";
import {
  getThread,
  listPendingThreadStorageDeletions,
  markThreadDeleted,
  projects,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runPeriodicSweeps,
  runThreadLifecycleSweep,
} from "../../src/services/system/periodic-sweeps.js";
import {
  reconcileDaemonReportedThreads,
  requestThreadStorageDeletion,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  admitThreadStorageDelete,
  clearThreadStorageDeleteRetryMemory,
  returnThreadStorageDeleteSlot,
  THREAD_STORAGE_DELETE_RETRY_MAX_MS,
} from "../../src/services/threads/thread-storage-delete-retries.js";
import {
  listQueuedCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const TICK_MS = 10_000;
const CAP_TICK_MS = 30_000;
const HOUR_MS = 60 * 60_000;
const START_MS = Date.UTC(2026, 10, 14, 0, 0, 0);
const BACKOFF_ATTEMPT_OFFSETS_MS = [0, 1, 3, 7, 15, 31].map(
  (minutes) => minutes * 60_000,
);
const GLOBAL_CAP_PER_MINUTE = 1;

interface StorageDeleteRequest {
  atMs: number;
  threadId: string;
}

afterEach(() => {
  vi.useRealTimers();
});

function seedDeletedThreads(
  harness: TestAppHarness,
  count: number,
  hostId = "host-refusing",
): {
  environment: { hostId: string; id: string };
  projectId: string;
  sessionId: string;
  threadIds: string[];
} {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/refused-storage-delete-${hostId}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/refused-storage-delete-${hostId}`,
    status: "ready",
  });
  const threadIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    threadIds.push(
      seedDeletedThreadIn(harness, {
        environmentId: environment.id,
        projectId: project.id,
      }),
    );
  }
  return {
    environment: { hostId: host.id, id: environment.id },
    projectId: project.id,
    sessionId: session.id,
    threadIds,
  };
}

function seedDeletedThreadIn(
  harness: TestAppHarness,
  args: { environmentId: string; projectId: string },
): string {
  const thread = seedThread(harness.deps, {
    environmentId: args.environmentId,
    projectId: args.projectId,
    status: "idle",
  });
  markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
  return thread.id;
}

async function refuseQueuedStorageDeletes(
  harness: TestAppHarness,
  atMs: number,
  releasedThreadIds: ReadonlySet<string> = new Set(),
): Promise<StorageDeleteRequest[]> {
  await sleep(5);
  const queued: QueuedCommand[] = [];
  const pending = listQueuedCommands(harness, "thread.storage.delete");
  if (pending.length === 0) return [];
  for (const command of pending) {
    if (command.type !== "thread.storage.delete") continue;
    queued.push(await findQueued(harness, command.threadId));
  }
  const requests: StorageDeleteRequest[] = [];
  for (const entry of queued) {
    if (entry.command.type !== "thread.storage.delete") continue;
    requests.push({ atMs, threadId: entry.command.threadId });
    if (releasedThreadIds.has(entry.command.threadId)) {
      await reportQueuedCommandSuccess(harness, entry, {
        providerCheckpointId: null,
      });
      continue;
    }
    await reportQueuedCommandError(harness, entry, {
      errorCode: "path_in_use",
      errorMessage:
        "process 4242 runs in another mount namespace without proven mount isolation",
    });
  }
  await sleep(1);
  return requests;
}

function findQueued(
  harness: TestAppHarness,
  threadId: string,
): Promise<QueuedCommand> {
  return waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.storage.delete" && command.threadId === threadId,
  );
}

function maxRequestsInAnyMinute(requests: StorageDeleteRequest[]): number {
  let max = 0;
  for (const request of requests) {
    const inWindow = requests.filter(
      (other) =>
        other.atMs >= request.atMs && other.atMs < request.atMs + 60_000,
    ).length;
    max = Math.max(max, inWindow);
  }
  return max;
}

describe("refused thread storage deletes", () => {
  it("backs off one refused thread instead of rescanning it on every tick", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const { projectId, threadIds } = seedDeletedThreads(harness, 1);
      harness.db
        .update(projects)
        .set({ deletedAt: START_MS })
        .where(eq(projects.id, projectId))
        .run();
      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      };
      const requests: StorageDeleteRequest[] = [];
      for (let offset = 0; offset < HOUR_MS; offset += TICK_MS) {
        vi.setSystemTime(START_MS + offset);
        await runPeriodicSweeps(deps);
        requests.push(...(await refuseQueuedStorageDeletes(harness, offset)));
        if (requests.length > BACKOFF_ATTEMPT_OFFSETS_MS.length) break;
      }
      vi.useRealTimers();

      expect(requests.map((request) => request.atMs)).toEqual(
        BACKOFF_ATTEMPT_OFFSETS_MS,
      );
      expect(new Set(requests.map((request) => request.threadId))).toEqual(
        new Set(threadIds),
      );
    });
  });

  it(
    "caps holder scans across a thousand refused threads over an hour",
    {
      timeout: 120_000,
    },
    async () => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START_MS);
        const { threadIds } = seedDeletedThreads(harness, 1_000);
        const requests: StorageDeleteRequest[] = [];
        for (let offset = 0; offset < HOUR_MS; offset += CAP_TICK_MS) {
          vi.setSystemTime(START_MS + offset);
          await runThreadLifecycleSweep(harness.deps);
          requests.push(...(await refuseQueuedStorageDeletes(harness, offset)));
          if (maxRequestsInAnyMinute(requests) > GLOBAL_CAP_PER_MINUTE) break;
        }
        vi.useRealTimers();

        expect(maxRequestsInAnyMinute(requests)).toBeLessThanOrEqual(
          GLOBAL_CAP_PER_MINUTE,
        );
        expect(requests.length).toBe(60 * GLOBAL_CAP_PER_MINUTE);
        const attempted = new Set(requests.map((request) => request.threadId));
        expect(attempted.size).toBe(requests.length);
        for (const threadId of attempted) {
          expect(threadIds).toContain(threadId);
        }
      });
    },
  );

  it(
    "requests another host's due delete on the first tick while one host has a thousand due",
    { timeout: 120_000 },
    async () => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START_MS);
        const backlog = seedDeletedThreads(harness, 1_000, "host-backlog");
        for (const threadId of backlog.threadIds) {
          requestThreadStorageDeletion(
            harness.deps,
            { environmentId: backlog.environment.id, id: threadId },
            backlog.environment,
          );
        }
        const refused = await refuseQueuedStorageDeletes(harness, 0);
        expect(refused).toHaveLength(backlog.threadIds.length);

        vi.setSystemTime(START_MS + 60_000);
        const other = seedDeletedThreads(harness, 1, "host-other");
        await runThreadLifecycleSweep(harness.deps);
        const firstTick = await refuseQueuedStorageDeletes(harness, 60_000);
        vi.useRealTimers();

        const backlogIds = new Set(backlog.threadIds);
        expect(
          firstTick.filter((request) => backlogIds.has(request.threadId)),
        ).toHaveLength(GLOBAL_CAP_PER_MINUTE);
        expect(
          firstTick.filter((request) => !backlogIds.has(request.threadId)),
        ).toEqual([{ atMs: 60_000, threadId: other.threadIds[0] }]);
      });
    },
  );

  it("retries a refused thread within one slot of its retry time while fresh deletes keep arriving", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const seeded = seedDeletedThreads(harness, 1);
      const refusedThreadId = seeded.threadIds[0] ?? "";
      const holderReleasedAtMs = 30_000;
      const refusedThreadRetryAtMs = 60_000;
      const released = new Set<string>();
      const refusedThreadRequests: number[] = [];
      for (let offset = 0; offset < 30 * 60_000; offset += TICK_MS) {
        vi.setSystemTime(START_MS + offset);
        if (offset % 60_000 === 50_000) {
          seedDeletedThreadIn(harness, {
            environmentId: seeded.environment.id,
            projectId: seeded.projectId,
          });
        }
        if (offset >= holderReleasedAtMs) released.add(refusedThreadId);
        await runThreadLifecycleSweep(harness.deps);
        const requests = await refuseQueuedStorageDeletes(
          harness,
          offset,
          released,
        );
        for (const request of requests) {
          if (request.threadId === refusedThreadId) {
            refusedThreadRequests.push(request.atMs);
          }
        }
        if (refusedThreadRequests.length > 1) break;
      }
      await runThreadLifecycleSweep(harness.deps);
      vi.useRealTimers();

      expect(refusedThreadRequests[0]).toBe(0);
      expect(refusedThreadRequests[1]).toBeLessThanOrEqual(
        refusedThreadRetryAtMs + 60_000,
      );
      expect(getThread(harness.db, refusedThreadId)).toBeNull();
    });
  });

  it("retries a refused thread within N+1 slots when the clock steps back before every slot", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const seeded = seedDeletedThreads(harness, 1);
      const refusedThreadId = seeded.threadIds[0] ?? "";
      await runThreadLifecycleSweep(harness.deps);
      expect(await refuseQueuedStorageDeletes(harness, 0)).toEqual([
        { atMs: 0, threadId: refusedThreadId },
      ]);
      const refusedThreadRetryAtMs = 60_000;
      const earlierStampMs = refusedThreadRetryAtMs - 10_000;
      const threadsDueAheadOfRefusedThread = 1;
      const released = new Set([refusedThreadId]);
      const refusedThreadRequests: number[] = [];
      for (let slot = 1; slot <= 30; slot += 1) {
        vi.setSystemTime(START_MS + earlierStampMs);
        seedDeletedThreadIn(harness, {
          environmentId: seeded.environment.id,
          projectId: seeded.projectId,
        });
        const slotMs = slot * 60_000;
        vi.setSystemTime(START_MS + slotMs);
        await runThreadLifecycleSweep(harness.deps);
        const requests = await refuseQueuedStorageDeletes(
          harness,
          slotMs,
          released,
        );
        for (const request of requests) {
          if (request.threadId === refusedThreadId) {
            refusedThreadRequests.push(request.atMs);
          }
        }
        if (refusedThreadRequests.length > 0) break;
      }
      await runThreadLifecycleSweep(harness.deps);
      vi.useRealTimers();

      expect(refusedThreadRequests).toHaveLength(1);
      expect(refusedThreadRequests[0]).toBeLessThanOrEqual(
        refusedThreadRetryAtMs + threadsDueAheadOfRefusedThread * 60_000,
      );
      expect(getThread(harness.db, refusedThreadId)).toBeNull();
    });
  });

  it.each(["sweep", "reconnect"] as const)(
    "orders a refused row whose re-queue write fails behind every queued row, so the delete behind it is sent in the next slot (%s)",
    async (path) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START_MS);
        const seeded = seedDeletedThreads(harness, 2, `host-requeue-${path}`);
        const [failingHead = "", behind = ""] = seeded.threadIds;
        listPendingThreadStorageDeletions(harness.db);
        harness.db.$client.exec(`
          CREATE TEMP TRIGGER fail_head_storage_delete_requeue
          BEFORE UPDATE OF storage_delete_seq ON threads
          WHEN OLD.id = '${failingHead}'
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;
        `);
        const warn = vi.spyOn(harness.deps.logger, "warn");
        const dispatch = async () => {
          if (path === "sweep") {
            await runThreadLifecycleSweep(harness.deps);
            return;
          }
          await reconcileDaemonReportedThreads(harness.deps, {
            activeThreadIds: [],
            hostId: seeded.environment.hostId,
            sameDaemonInstance: false,
            undeliveredEventThreadIds: [],
          });
        };
        const released = new Set([behind]);
        const requestsBySlot: string[][] = [];
        for (let slot = 0; slot < 2; slot += 1) {
          vi.setSystemTime(START_MS + slot * 60_000);
          await dispatch();
          const requests = await refuseQueuedStorageDeletes(
            harness,
            slot * 60_000,
            released,
          );
          requestsBySlot.push(requests.map((request) => request.threadId));
        }
        harness.db.$client.exec(
          "DROP TRIGGER fail_head_storage_delete_requeue",
        );
        released.add(failingHead);
        vi.setSystemTime(START_MS + 2 * 60_000);
        await runThreadLifecycleSweep(harness.deps);
        requestsBySlot.push(
          (await refuseQueuedStorageDeletes(harness, 2 * 60_000, released)).map(
            (request) => request.threadId,
          ),
        );
        await runThreadLifecycleSweep(harness.deps);
        vi.useRealTimers();

        expect(requestsBySlot).toEqual([
          [failingHead],
          [behind],
          [failingHead],
        ]);
        expect(getThread(harness.db, behind)).toBeNull();
        expect(getThread(harness.db, failingHead)).toBeNull();
        expect(
          warn.mock.calls.filter(
            ([, message]) =>
              message === "Thread storage deletion could not be re-queued",
          ),
        ).toHaveLength(1);
      });
    },
  );

  it.each(["sweep", "reconnect"] as const)(
    "keeps a refused row whose re-queue write fails at the back of the rows pending when it failed, so rows re-queued after it never pass it (%s)",
    async (path) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(START_MS);
        const seeded = seedDeletedThreads(
          harness,
          4,
          `host-requeue-starve-${path}`,
        );
        const byId = [...seeded.threadIds].sort();
        const failing = byId[3] ?? "";
        const firstRequeuedAfter = byId[0] ?? "";
        const queueOrder = [failing, firstRequeuedAfter, byId[1], byId[2]].map(
          (threadId) => threadId ?? "",
        );
        listPendingThreadStorageDeletions(harness.db);
        queueOrder.forEach((threadId, index) => {
          harness.db
            .update(threads)
            .set({ storageDeleteSeq: index + 1 })
            .where(eq(threads.id, threadId))
            .run();
        });
        harness.db.$client.exec(`
          CREATE TEMP TRIGGER fail_storage_delete_requeue
          BEFORE UPDATE OF storage_delete_seq ON threads
          WHEN OLD.id = '${failing}'
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;
        `);
        const warn = vi.spyOn(harness.deps.logger, "warn");
        const cycles = 3;
        const sentBySlot: string[][] = [];
        for (let slot = 0; slot < cycles * queueOrder.length; slot += 1) {
          const slotMs = slot * THREAD_STORAGE_DELETE_RETRY_MAX_MS;
          vi.setSystemTime(START_MS + slotMs);
          if (path === "sweep") {
            await runThreadLifecycleSweep(harness.deps);
          } else {
            await reconcileDaemonReportedThreads(harness.deps, {
              activeThreadIds: [],
              hostId: seeded.environment.hostId,
              sameDaemonInstance: false,
              undeliveredEventThreadIds: [],
            });
          }
          sentBySlot.push(
            (await refuseQueuedStorageDeletes(harness, slotMs)).map(
              (request) => request.threadId,
            ),
          );
        }
        harness.db.$client.exec("DROP TRIGGER fail_storage_delete_requeue");
        vi.useRealTimers();

        expect(firstRequeuedAfter < failing).toBe(true);
        expect(sentBySlot).toEqual(
          Array.from({ length: cycles }, () =>
            queueOrder.map((threadId) => [threadId]),
          ).flat(),
        );
        expect(
          warn.mock.calls.filter(
            ([, message]) =>
              message === "Thread storage deletion could not be re-queued",
          ),
        ).toHaveLength(1);
      });
    },
  );

  it("keeps a row's place when the server dies after its dispatch but before the command is handed off, so it is handed off in the next slot", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const seeded = seedDeletedThreads(harness, 2, "host-dies-before-handoff");
      const [threadX = "", threadY = ""] = seeded.threadIds;
      listPendingThreadStorageDeletions(harness.db);
      const seqOf = (threadId: string) =>
        listPendingThreadStorageDeletions(harness.db).find(
          (thread) => thread.id === threadId,
        )?.storageDeleteSeq;
      const restart = () => {
        clearThreadStorageDeleteRetryMemory(harness.db);
        registerTestHostRpcCapture(harness, {
          hostId: seeded.environment.hostId,
          sessionId: seeded.sessionId,
        });
      };
      const released = new Set([threadX]);
      const handedOffBySlot: string[][] = [];
      let restarts = 0;
      for (let slot = 0; slot < 6; slot += 1) {
        const slotMs = slot * 60_000;
        vi.setSystemTime(START_MS + slotMs);
        if (slot > 0) {
          restart();
          restarts += 1;
        }
        const seqBeforeDispatch = seqOf(threadX);
        await runThreadLifecycleSweep(harness.deps);
        await sleep(5);
        const dispatched = listQueuedCommands(
          harness,
          "thread.storage.delete",
        ).flatMap((command) =>
          command.type === "thread.storage.delete" ? [command.threadId] : [],
        );
        const diesBeforeHandoff =
          dispatched.includes(threadX) &&
          (slot === 0 || seqOf(threadX) !== seqBeforeDispatch);
        if (diesBeforeHandoff) {
          handedOffBySlot.push([]);
          continue;
        }
        const handedOff = await refuseQueuedStorageDeletes(
          harness,
          slotMs,
          released,
        );
        handedOffBySlot.push(handedOff.map((request) => request.threadId));
        if (handedOff.some((request) => request.threadId === threadX)) break;
      }
      await runThreadLifecycleSweep(harness.deps);
      vi.useRealTimers();

      expect(handedOffBySlot).toEqual([[], [threadX]]);
      expect(restarts).toBe(1);
      expect(getThread(harness.db, threadX)).toBeNull();
      expect(getThread(harness.db, threadY)).not.toBeNull();
    });
  });

  it("re-sends the front row first after each restart between its handoff and its refusal, then serves the row behind it", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const seeded = seedDeletedThreads(harness, 2, "host-dies-after-handoff");
      const [threadX = "", threadY = ""] = seeded.threadIds;
      const restartsBeforeOutcome = 3;
      const handedOffBySlot: string[][] = [];
      for (let slot = 0; slot <= restartsBeforeOutcome + 1; slot += 1) {
        const slotMs = slot * 60_000;
        vi.setSystemTime(START_MS + slotMs);
        await runThreadLifecycleSweep(harness.deps);
        await sleep(5);
        if (slot < restartsBeforeOutcome) {
          handedOffBySlot.push(
            listQueuedCommands(harness, "thread.storage.delete").flatMap(
              (command) =>
                command.type === "thread.storage.delete"
                  ? [command.threadId]
                  : [],
            ),
          );
          clearThreadStorageDeleteRetryMemory(harness.db);
          registerTestHostRpcCapture(harness, {
            hostId: seeded.environment.hostId,
            sessionId: seeded.sessionId,
          });
          continue;
        }
        const handedOff = await refuseQueuedStorageDeletes(harness, slotMs);
        handedOffBySlot.push(handedOff.map((request) => request.threadId));
      }
      vi.useRealTimers();

      expect(handedOffBySlot).toEqual([
        ...Array.from({ length: restartsBeforeOutcome }, () => [threadX]),
        [threadX],
        [threadY],
      ]);
      expect(
        handedOffBySlot.findIndex((threadIds) => threadIds.includes(threadY)),
      ).toBe(restartsBeforeOutcome + 1);
    });
  });

  it("gives a gated slot back only for the dispatch that was not sent", async () => {
    await withTestHarness(async (harness) => {
      const args = { hostId: "host-slot", now: START_MS, threadId: "thr_a" };
      expect(
        admitThreadStorageDelete(harness.db, { ...args, gate: "cap" }),
      ).toBe(true);
      expect(
        admitThreadStorageDelete(harness.db, {
          ...args,
          gate: "cap",
          threadId: "thr_b",
        }),
      ).toBe(false);
      returnThreadStorageDeleteSlot(harness.db, { ...args, gate: "none" });
      expect(
        admitThreadStorageDelete(harness.db, {
          ...args,
          gate: "cap",
          threadId: "thr_b",
        }),
      ).toBe(false);
      returnThreadStorageDeleteSlot(harness.db, { ...args, gate: "cap" });
      expect(
        admitThreadStorageDelete(harness.db, {
          ...args,
          gate: "backoff-and-cap",
          threadId: "thr_b",
        }),
      ).toBe(true);
      clearThreadStorageDeleteRetryMemory(harness.db);
    });
  });

  it("lists only the deleting project's pending storage deletes, in queue order", async () => {
    await withTestHarness(async (harness) => {
      const deleting = seedDeletedThreads(harness, 2, "host-deleting");
      const other = seedDeletedThreads(harness, 2, "host-other-project");

      const pending = listPendingThreadStorageDeletions(harness.db, {
        projectId: deleting.projectId,
      });

      expect(pending.map((thread) => thread.id)).toEqual(deleting.threadIds);
      expect(
        listPendingThreadStorageDeletions(harness.db).map(
          (thread) => thread.id,
        ),
      ).toEqual([...deleting.threadIds, ...other.threadIds]);
    });
  });

  it("deletes and purges a refused thread within N+1 slots across restarts, clock rollbacks and older-rowid arrivals", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      const { host } = seedHostSession(harness.deps, { id: "host-restarting" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/refused-storage-delete-restarting",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/refused-storage-delete-restarting",
        status: "ready",
      });
      const slotCount = 20;
      const olderRowidArrivals = Array.from(
        { length: slotCount },
        () =>
          seedThread(harness.deps, {
            environmentId: environment.id,
            projectId: project.id,
            status: "idle",
          }).id,
      );
      const seedDeleted = (minutesBeforeStart: number) => {
        vi.setSystemTime(START_MS - minutesBeforeStart * 60_000);
        return seedDeletedThreadIn(harness, {
          environmentId: environment.id,
          projectId: project.id,
        });
      };
      const alwaysRefusedThreadId = seedDeleted(4);
      const dueRowsAheadOfA = [
        alwaysRefusedThreadId,
        seedDeleted(3),
        seedDeleted(2),
        seedDeleted(1),
      ];
      const threadA = seedDeleted(0);
      const released = new Set([threadA]);
      const requestsBySlot: string[][] = [];
      for (let slot = 0; slot < slotCount; slot += 1) {
        const slotMs = -slot * 60_000;
        vi.setSystemTime(START_MS + slotMs);
        if (slot > 0) {
          clearThreadStorageDeleteRetryMemory(harness.db);
          markThreadDeleted(harness.db, harness.hub, {
            threadId: olderRowidArrivals[slot - 1] ?? "",
          });
          await reconcileDaemonReportedThreads(harness.deps, {
            activeThreadIds: [],
            hostId: host.id,
            sameDaemonInstance: false,
            undeliveredEventThreadIds: [],
          });
        }
        await runThreadLifecycleSweep(harness.deps);
        const requests = await refuseQueuedStorageDeletes(
          harness,
          slotMs,
          released,
        );
        requestsBySlot.push(requests.map((request) => request.threadId));
        if (requests.some((request) => request.threadId === threadA)) break;
      }
      await runThreadLifecycleSweep(harness.deps);
      vi.useRealTimers();

      const slotServingA = requestsBySlot.findIndex((threadIds) =>
        threadIds.includes(threadA),
      );
      expect(requestsBySlot.every((threadIds) => threadIds.length === 1)).toBe(
        true,
      );
      expect(slotServingA).toBeGreaterThanOrEqual(0);
      expect(slotServingA).toBeLessThanOrEqual(dueRowsAheadOfA.length);
      expect(requestsBySlot.flat()).toContain(alwaysRefusedThreadId);
      expect(getThread(harness.db, threadA)).toBeNull();
    });
  });
});
