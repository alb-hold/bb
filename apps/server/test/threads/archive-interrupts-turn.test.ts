import { createConnection, getThread, listEvents, migrate } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import * as threadLifecycle from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { seedThreadFixture, seedTurnStarted } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function memoryDatabase() {
  const db = createConnection(":memory:");
  migrate(db);
  return db;
}

async function archive(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/archive-all`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
  expect(getThread(harness.db, threadId)?.archivedAt).toEqual(
    expect.any(Number),
  );
}

describe("archive interrupts active turns", () => {
  it("interrupts exactly once before archiving and completes the turn as interrupted", async () => {
    await withTestHarness({ db: memoryDatabase() }, async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        environment: { status: "ready" },
        thread: { status: "active" },
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "archive-active-turn",
      });
      const request = threadLifecycle.requestThreadStopForCurrentState;
      const rpc = vi.spyOn(threadLifecycle, "requestThreadStopForCurrentState");
      const beforeArchive: (number | null | undefined)[] = [];
      rpc.mockImplementation((...args) => {
        beforeArchive.push(getThread(harness.db, thread.id)?.archivedAt);
        return request(...args);
      });
      try {
        await archive(harness, thread.id);
        expect(
          listQueuedThreadCommands(harness, "thread.stop", thread.id),
        ).toHaveLength(1);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
        );
        expect(stop.command).toMatchObject({ intent: "interrupt" });
        expect(beforeArchive[0]).toBeNull();
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
        });
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        const completions = listEvents(harness.db, {
          threadId: thread.id,
        }).filter((event) => event.type === "turn/completed");
        expect(completions).toHaveLength(1);
        expect(JSON.parse(completions[0]!.data)).toMatchObject({
          status: "interrupted",
        });
      } finally {
        rpc.mockRestore();
      }
    });
  });

  it("archives an idle thread without interrupting", async () => {
    await withTestHarness({ db: memoryDatabase() }, async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      await archive(harness, thread.id);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it("keeps the archive when the interrupt fails and logs the failure", async () => {
    await withTestHarness({ db: memoryDatabase() }, async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        environment: { status: "ready" },
        thread: { status: "active" },
      });
      const warn = vi.spyOn(harness.deps.logger, "warn");
      try {
        await archive(harness, thread.id);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
        );
        await reportQueuedCommandError(harness, stop, {
          errorCode: "test_interrupt_failure",
          errorMessage: "Interrupt failed",
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).toEqual(
          expect.any(Number),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ threadId: thread.id }),
          "Live thread stop command failed",
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
