import { setTimeout as sleep } from "node:timers/promises";
import {
  getEnvironment,
  getThread,
  listEvents,
  markThreadDeleted,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import type { EnvironmentRow } from "@bb/db";
import type { Thread } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  finalizeStoppedThread,
  hasLiveThreadStopInFlight,
  requestThreadStorageDeletion,
  requestThreadStopForCurrentState,
  stopThreadForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import { HostOnlineRpcTimeoutError } from "../../src/ws/hub.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface ActiveThreadStopFixture {
  environment: EnvironmentRow;
  thread: Thread;
}

interface SeedActiveThreadStopFixtureArgs {
  harness: TestAppHarness;
  value: number;
}

interface WaitForStopRpcIdleArgs {
  threadId: string;
}

function seedActiveThreadStopFixture(
  args: SeedActiveThreadStopFixtureArgs & { providerBacked?: boolean },
): ActiveThreadStopFixture {
  const { host } = seedHostSession(args.harness.deps, {
    id: `host-thread-stop-retry-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
    status: "ready",
    ...(args.providerBacked
      ? {
          environmentProviderId: "retained-worktree",
          environmentProviderPluginId: "test-retained-worktree",
          providerOwnsPath: true,
        }
      : {}),
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });

  return { environment, thread };
}

async function waitForStopRpcIdle(args: WaitForStopRpcIdleArgs): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!hasLiveThreadStopInFlight(args.threadId)) {
      return;
    }
    await sleep(10);
  }

  throw new Error("Timed out waiting for live thread stop RPC to settle");
}

describe("thread stop dispatch", () => {
  it("schedules provider retirement after storage deletion is retained", async () => {
    await withTestHarness(async (harness) => {
      const provider = validatePluginEnvironmentProviderDeclaration({
        id: "retained-worktree",
        displayName: "Retained Worktree",
        description: "A provider used by the retained storage test.",
        icon: "Folder",
        policy: { retireGraceMs: 0 },
        create: async () => ({
          status: "failed" as const,
          message: "not used by this test",
        }),
        remove: async () => ({ status: "removed" as const }),
      });
      const record = { pluginId: "test-retained-worktree", provider };
      setPluginEnvironmentProviderBridge({
        listEnvironmentProviders: () => [record],
        getEnvironmentProvider: (id) =>
          id === provider.id ? record : undefined,
        invokeProvider: async (_record, _label, run) => ({
          ok: true,
          value: await run(),
        }),
        decisionTimeoutMs: 10_000,
      });
      try {
        const { environment, thread } = seedActiveThreadStopFixture({
          harness,
          value: 8,
          providerBacked: true,
        });
        harness.db
          .update(threads)
          .set({ status: "idle" })
          .where(eq(threads.id, thread.id))
          .run();
        markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

        requestThreadStorageDeletion(harness.deps, thread, environment);
        const deleteCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.storage.delete" &&
            command.threadId === thread.id,
        );
        await reportQueuedCommandError(harness, deleteCommand, {
          errorCode: "path_in_use",
          errorMessage:
            "The storage path is retained because a foreign-user process could not be inspected",
        });

        await expect
          .poll(() => getEnvironment(harness.db, environment.id)?.retireAt)
          .toEqual(expect.any(Number));
        expect(getThread(harness.db, thread.id)).toMatchObject({
          deletedAt: expect.any(Number),
          storageDeletedAt: null,
        });
      } finally {
        setPluginEnvironmentProviderBridge(undefined);
      }
    });
  });

  it("keeps a deleted thread tombstone until storage deletion succeeds", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 5,
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      requestThreadStorageDeletion(harness.deps, thread, environment);
      const failedDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === thread.id,
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });

      await reportQueuedCommandError(harness, failedDelete, {
        errorCode: "test_storage_delete_failure",
        errorMessage: "Test storage delete failure",
      });
      await sleep(10);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        storageDeletedAt: null,
      });

      requestThreadStorageDeletion(harness.deps, thread, environment);
      const successfulDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, successfulDelete, {
        providerCheckpointId: null,
      });

      expect(getThread(harness.db, thread.id)).toBeNull();
    });
  });

  it("keeps attached storage pending when its environment is unavailable", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedActiveThreadStopFixture({ harness, value: 6 });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      requestThreadStorageDeletion(harness.deps, thread, null);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });
      expect(
        listQueuedThreadCommands(harness, "thread.storage.delete", thread.id),
      ).toHaveLength(0);
    });
  });

  it("does not re-dispatch the stop after a live stop RPC failure", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 1,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "test_thread_stop_failure",
        errorMessage: "Test live stop failure",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(hasLiveThreadStopInFlight(thread.id)).toBe(false);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it("settles a stopped thread when the host reports no runtime exists", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 4,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "unknown_environment",
        errorMessage: "No runtime exists for environment env_missing_runtime",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(0);
    });
  });

  it("settles a thread whose host never answers the stop", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 7,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "turn-stop-unanswered",
      });
      const rpc = vi
        .spyOn(harness.hub, "requestHostOnlineRpc")
        .mockRejectedValue(new HostOnlineRpcTimeoutError());

      await stopThreadForCurrentState(harness.deps, thread, environment);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      expect(rpc).toHaveBeenCalledOnce();
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(1);
    });
  });

  it("treats a second stop completion as a no-op after the stop already settled", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 3,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "turn-stop-settles-twice",
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: "pi-entry-at-stop",
      });
      const settled = getThread(harness.db, thread.id);
      expect(settled).toMatchObject({
        status: "idle",
      });

      finalizeStoppedThread(harness.deps, {
        threadId: thread.id,
      });

      expect(getThread(harness.db, thread.id)).toEqual(settled);
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(1);
      const completion = threadEvents.find(
        (event) => event.type === "turn/completed",
      );
      expect(completion).toBeDefined();
      expect(JSON.parse(completion?.data ?? "{}")).toMatchObject({
        providerCheckpointId: "pi-entry-at-stop",
        status: "interrupted",
      });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not queue duplicate stop commands while a stop RPC is in flight", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 2,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const firstStopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, firstStopCommand, {
        providerCheckpointId: null,
      });
      await waitForStopRpcIdle({ threadId: thread.id });
    });
  });
});
