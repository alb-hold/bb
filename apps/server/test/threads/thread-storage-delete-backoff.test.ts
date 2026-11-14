import { setTimeout as sleep } from "node:timers/promises";
import { getThread, markThreadDeleted, projects } from "@bb/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runPeriodicSweeps,
  runThreadLifecycleSweep,
} from "../../src/services/system/periodic-sweeps.js";
import { requestThreadStorageDeletion } from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedCommands,
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
  threadIds: string[];
} {
  const { host } = seedHostSession(harness.deps, { id: hostId });
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
});
