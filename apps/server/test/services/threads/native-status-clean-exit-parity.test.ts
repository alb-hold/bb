import {
  createNativeTerminalThread,
  createTerminalSession,
  getThread,
  setNativeTerminalThreadTerminal,
} from "@bb/db";
import { threadListEntrySchema, withEffectiveDisplayStatus } from "@bb/domain";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function withHarness(
  run: (harness: TestAppHarness) => Promise<void>,
): Promise<void> {
  const harness = await createTestAppHarness();
  try {
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

function seedExitedNativeThread(
  harness: TestAppHarness,
  args: {
    initialStatus: "active" | "idle";
    exitCode: number | null;
    closeReason: "process-exit";
  },
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `native-exit-host-${Math.random().toString(36).slice(2, 8)}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/native-exit-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/native-exit-worktree",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "claude-code",
    status: args.initialStatus,
  });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    daemonSessionId: session.id,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: "/tmp/native-exit-worktree",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Claude Code",
  });
  createNativeTerminalThread(harness.db, {
    threadId: thread.id,
    providerId: "claude-code",
    nativeSessionId: `session-${thread.id}`,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  setNativeTerminalThreadTerminal(harness.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  harness.db.$client
    .prepare(
      "UPDATE terminal_sessions SET status = 'exited', close_reason = ?, exit_code = ? WHERE id = ?",
    )
    .run(args.closeReason, args.exitCode, terminal.id);
  return { threadId: thread.id, terminalId: terminal.id };
}

describe("V4: native terminal clean exit status parity across API and CLI", () => {
  it("reports idle consistently in API detail, API list, and SDK/CLI after clean exit of an idle native thread", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedExitedNativeThread(harness, {
        initialStatus: "idle",
        closeReason: "process-exit",
        exitCode: 0,
      });

      const detailResponse = await harness.app.request(
        `/api/v1/threads/${threadId}`,
      );
      expect(detailResponse.status).toBe(200);
      const detail = threadResponseSchema.parse(await detailResponse.json());
      const cliDetail = withEffectiveDisplayStatus(detail);

      expect(detail.status).toBe("idle");
      expect(detail.runtime.displayStatus).toBe("idle");
      expect(detail.runtime.nativeSessionExit).toBe("clean");
      expect(cliDetail.status).toBe(detail.status);
      expect(cliDetail.runtime.displayStatus).toBe(detail.runtime.displayStatus);

      const listResponse = await harness.app.request(
        `/api/v1/threads?threadIds=${threadId}`,
      );
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()).map((row: unknown) =>
        threadListEntrySchema.parse(row),
      );
      const listEntry = list.find(
        (entry: { id: string }) => entry.id === threadId,
      );
      expect(listEntry).toBeDefined();
      expect(listEntry?.status).toBe("idle");
      expect(listEntry?.runtime.displayStatus).toBe("idle");
      expect(listEntry?.runtime.nativeSessionExit).toBe("clean");
      expect(getThread(harness.db, threadId)?.status).toBe("idle");
    });
  });

  it("still settles non-zero exit of an idle thread and terminal loss of a running thread to error", async () => {
    await withHarness(async (harness) => {
      const nonZero = seedExitedNativeThread(harness, {
        initialStatus: "idle",
        closeReason: "process-exit",
        exitCode: 1,
      });
      const activeLost = seedExitedNativeThread(harness, {
        initialStatus: "active",
        closeReason: "process-exit",
        exitCode: 0,
      });

      const nonZeroResponse = await harness.app.request(
        `/api/v1/threads/${nonZero.threadId}`,
      );
      expect(nonZeroResponse.status).toBe(200);
      const nonZeroDetail = threadResponseSchema.parse(
        await nonZeroResponse.json(),
      );
      expect(nonZeroDetail.status).toBe("error");
      expect(nonZeroDetail.runtime.displayStatus).toBe("error");
      expect(nonZeroDetail.runtime.nativeSessionExit).toBeUndefined();

      const activeLostResponse = await harness.app.request(
        `/api/v1/threads/${activeLost.threadId}`,
      );
      expect(activeLostResponse.status).toBe(200);
      const activeLostDetail = threadResponseSchema.parse(
        await activeLostResponse.json(),
      );
      expect(activeLostDetail.status).toBe("error");
      expect(activeLostDetail.runtime.displayStatus).toBe("error");

      await vi.waitFor(() => {
        expect(getThread(harness.db, nonZero.threadId)?.status).toBe("error");
        expect(getThread(harness.db, activeLost.threadId)?.status).toBe(
          "error",
        );
      });
    });
  });
});
