import {
  createNativeTerminalThread,
  createTerminalSession,
  getNativeTerminalThread,
  getTerminalSession,
  getThread,
  setNativeTerminalThreadTerminal,
  threads,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  expireArchiveUndoGrace,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedArchivableActiveThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    environment: { path: "/tmp/archive-undo-grace", status: "ready" },
    thread: { status: "active" },
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: `turn-${fixture.thread.id}`,
  });
  return fixture;
}

function seedRunningTerminal(
  harness: TestAppHarness,
  args: { environmentId: string; hostId: string; threadId: string },
) {
  return createTerminalSession(harness.deps.db, {
    cols: 80,
    daemonSessionId: null,
    environmentId: args.environmentId,
    hostId: args.hostId,
    initialCwd: "/tmp/archive-undo-grace",
    rows: 24,
    status: "running",
    threadId: args.threadId,
    title: "dev server",
  });
}

async function archiveThread(
  harness: TestAppHarness,
  threadId: string,
): Promise<void> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/archive-all`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
}

describe("archive undo grace", () => {
  it("interrupts a running turn without waiting for the archive undo grace", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedArchivableActiveThread(harness);

      await archiveThread(harness, thread.id);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);

      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, thread.id)?.status).toBe("stopping");
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);
    });
  });

  it("stops a thread still running once its archive undo grace elapses", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedArchivableActiveThread(harness);

      await archiveThread(harness, thread.id);
      expireArchiveUndoGrace(harness.deps, thread.id);
      await runThreadLifecycleSweep(harness.deps);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.command).toMatchObject({
        type: "thread.stop",
        environmentId: environment.id,
        threadId: thread.id,
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("stopping");
    });
  });

  it("does not repeat the interrupt when unarchived inside the grace", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedArchivableActiveThread(harness);

      await archiveThread(harness, thread.id);
      const unarchiveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );
      expect(unarchiveResponse.status).toBe(200);
      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: null,
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);
    });
  });

  it("stops an archived thread that is not running without waiting for the grace", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        environment: {
          path: "/tmp/archive-undo-grace-starting",
          status: "ready",
        },
        thread: { status: "starting" },
      });

      await archiveThread(harness, thread.id);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        status: "idle",
      });
    });
  });

  it("keeps the terminals of a running thread open for the grace, then closes them", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedArchivableActiveThread(harness);
      const terminal = seedRunningTerminal(harness, {
        environmentId: environment.id,
        hostId: host.id,
        threadId: thread.id,
      });

      await archiveThread(harness, thread.id);
      await runThreadLifecycleSweep(harness.deps);

      expect(
        getTerminalSession(harness.db, {
          kind: "terminal",
          terminalId: terminal.id,
        }),
      ).toMatchObject({
        closeReason: null,
        status: "running",
      });

      expireArchiveUndoGrace(harness.deps, thread.id);
      await runThreadLifecycleSweep(harness.deps);

      expect(
        getTerminalSession(harness.db, {
          kind: "terminal",
          terminalId: terminal.id,
        }),
      ).toMatchObject({
        closeReason: "thread-archived",
        status: "exited",
      });
    });
  });

  it("closes a native terminal immediately while preserving archive undo grace for the thread", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedArchivableActiveThread(harness);
      const terminal = seedRunningTerminal(harness, {
        environmentId: environment.id,
        hostId: host.id,
        threadId: thread.id,
      });
      createNativeTerminalThread(harness.db, {
        threadId: thread.id,
        providerId: "claude-code",
        nativeSessionId: null,
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      setNativeTerminalThreadTerminal(harness.db, {
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });

      await archiveThread(harness, thread.id);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        archivedAt: expect.any(Number),
        status: "active",
      });
      expect(
        getTerminalSession(harness.db, {
          kind: "terminal",
          terminalId: terminal.id,
        }),
      ).toMatchObject({
        closeReason: "thread-archived",
        status: "exited",
      });
      expect(
        getNativeTerminalThread(harness.db, thread.id)?.terminalSessionId,
      ).toBe(terminal.id);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
    });
  });

  it("keeps the terminals of an archived thread for the grace after its turn ends", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedArchivableActiveThread(harness);
      const terminal = seedRunningTerminal(harness, {
        environmentId: environment.id,
        hostId: host.id,
        threadId: thread.id,
      });

      await archiveThread(harness, thread.id);
      harness.deps.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      await runThreadLifecycleSweep(harness.deps);

      expect(
        getTerminalSession(harness.db, {
          kind: "terminal",
          terminalId: terminal.id,
        }),
      ).toMatchObject({ closeReason: null, status: "running" });

      expireArchiveUndoGrace(harness.deps, thread.id);
      await runThreadLifecycleSweep(harness.deps);

      expect(
        getTerminalSession(harness.db, {
          kind: "terminal",
          terminalId: terminal.id,
        }),
      ).toMatchObject({ closeReason: "thread-archived", status: "exited" });
    });
  });
});
