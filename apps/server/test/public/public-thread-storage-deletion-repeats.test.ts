import {
  getThread,
  markThreadDeleted,
  markThreadStorageDeleted,
  requestThreadPurge,
  threadPurges,
} from "@bb/db";
import { expect, it, vi } from "vitest";
import {
  advanceProjectDeletion,
  beginProjectDeletion,
} from "../../src/services/projects/project-deletion.js";
import { reconcileDaemonReportedThreads } from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it.each(["idle", "error", "active", "starting", "stopping"] as const)(
  "does not repeat completed storage deletion on reconnect for %s threads",
  async (status) => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const completed = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status,
      });
      const pending = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      for (const thread of [completed, pending]) {
        markThreadDeleted(harness.db, harness.deps.hub, {
          threadId: thread.id,
        });
      }
      markThreadStorageDeleted(harness.db, { threadId: completed.id });
      if (status === "idle" || status === "error") {
        requestThreadPurge(harness.db, {
          now: Date.now(),
          threadId: completed.id,
        });
      }

      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        turnCommandThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: false,
      });
      const retry = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === pending.id,
      );
      const commands = listQueuedCommands(harness, "thread.storage.delete");
      await reportQueuedCommandSuccess(harness, retry, {
        providerCheckpointId: null,
      });
      expect(commands).toEqual([
        expect.objectContaining({ threadId: pending.id }),
      ]);
    });
  },
);

it("sends at most one reconnect storage deletion per minute to a host", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const deleted = Array.from({ length: 6 }, () =>
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      }),
    );
    for (const thread of deleted) {
      markThreadDeleted(harness.db, harness.deps.hub, { threadId: thread.id });
    }

    const startedAt = Date.now();
    const reconnect = () =>
      reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        turnCommandThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: false,
      });
    const now = vi.spyOn(Date, "now");
    try {
      for (let sent = 0; sent < deleted.length; sent += 1) {
        now.mockReturnValue(startedAt + sent * 61_000);
        await reconnect();
        await reconnect();
        await expect
          .poll(
            () => listQueuedCommands(harness, "thread.storage.delete").length,
          )
          .toBe(1);
        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "thread.storage.delete",
        );
        await reportQueuedCommandSuccess(harness, queued, {
          providerCheckpointId: null,
        });
      }
    } finally {
      now.mockRestore();
    }
    await expect
      .poll(() =>
        deleted.map(
          (thread) =>
            getThread(harness.db, thread.id)?.storageDeletedAt ?? null,
        ),
      )
      .not.toContain(null);
  });
});

it("retries only unfinished storage deletion while a project deletion is pending", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const [storageGone, succeeds, fails] = Array.from({ length: 3 }, () =>
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      }),
    );
    markThreadDeleted(harness.db, harness.deps.hub, {
      threadId: storageGone.id,
    });
    markThreadStorageDeleted(harness.db, { threadId: storageGone.id });
    const storageDeleteThreadIds = () =>
      listQueuedCommands(harness, "thread.storage.delete")
        .map((command) =>
          command.type === "thread.storage.delete" ? command.threadId : null,
        )
        .sort();
    const queuedFor = (threadId: string) =>
      waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === threadId,
      );

    beginProjectDeletion(harness.deps, { projectId: project.id });
    const succeedsCommand = await queuedFor(succeeds.id);
    const failsCommand = await queuedFor(fails.id);
    expect(storageDeleteThreadIds()).toEqual([succeeds.id, fails.id].sort());
    expect(
      harness.db
        .select({ threadId: threadPurges.threadId })
        .from(threadPurges)
        .all(),
    ).toEqual([{ threadId: storageGone.id }]);
    await reportQueuedCommandSuccess(harness, succeedsCommand, {
      providerCheckpointId: null,
    });
    await reportQueuedCommandError(harness, failsCommand, {
      errorCode: "temporary_failure",
      errorMessage: "Host disconnected",
    });

    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(Date.now() + 2 * 60 * 60_000);
      await advanceProjectDeletion(harness.deps, { projectId: project.id });
      const retry = await queuedFor(fails.id);
      expect(storageDeleteThreadIds()).toEqual([fails.id]);
      await reportQueuedCommandSuccess(harness, retry, {
        providerCheckpointId: null,
      });
    } finally {
      now.mockRestore();
    }
  });
});
