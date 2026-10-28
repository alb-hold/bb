import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeTerminalThread,
  createTerminalSession,
  getNativeTerminalThread,
  getThread,
  listEvents,
  setNativeTerminalThreadTerminal,
  stampNativeTerminalTranscriptEvidence,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { turnRequestEventDataSchema } from "@bb/domain";
import { runPeriodicSweeps } from "../../../src/services/system/periodic-sweeps.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../../helpers/commands.js";

const WORKING_TRANSCRIPT =
  JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    message: { content: [{ type: "text", text: "Continue" }] },
  }) +
  "\n" +
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { content: [{ type: "text", text: "Twisting..." }] },
  }) +
  "\n";

type TerminalState =
  | "running"
  | "exited-process-exit"
  | "exited-process-exit-code-1"
  | "exited-daemon-disconnect";

interface SeededNativeThread {
  threadId: string;
}

function seedNativeContext(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "status-host",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/native-status-worktree",
  });
  return { environment, host, project, session };
}

function seedNativeThread(
  harness: TestAppHarness,
  args: {
    initialStatus: "active" | "idle";
    parentThreadId?: string;
    terminal: TerminalState;
  },
  context: ReturnType<typeof seedNativeContext> = seedNativeContext(harness),
): SeededNativeThread {
  const { environment, host, project, session } = context;
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "claude-code",
    status: args.initialStatus,
    ...(args.parentThreadId === undefined
      ? {}
      : { parentThreadId: args.parentThreadId }),
  });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    daemonSessionId: session.id,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: "/tmp/native-status-worktree",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Native terminal",
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
  if (args.terminal !== "running") {
    const closeReason =
      args.terminal === "exited-daemon-disconnect"
        ? "daemon-disconnect"
        : "process-exit";
    const exitCode = args.terminal === "exited-process-exit-code-1" ? 1 : 0;
    harness.db.$client
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited', close_reason = ?, exit_code = ? WHERE id = ?",
      )
      .run(closeReason, exitCode, terminal.id);
  }
  return { threadId: thread.id };
}

async function readThreadStatus(
  harness: TestAppHarness,
  threadId: string,
  transcriptRpc: "expected" | "not-expected",
): Promise<string> {
  const responsePromise = harness.app.request(`/api/v1/threads/${threadId}`);
  const isTranscriptRead = ({ command }: QueuedCommand) =>
    command.type === "native_terminal.read_transcript_tail";
  const queued =
    transcriptRpc === "expected"
      ? await waitForQueuedCommand(harness, isTranscriptRead)
      : await waitForQueuedCommand(harness, isTranscriptRead, 250).catch(
          () => null,
        );
  if (queued !== null) {
    await reportQueuedCommandSuccess(harness, queued, {
      outcome: "available",
      contentBase64: Buffer.from(WORKING_TRANSCRIPT).toString("base64"),
      sizeBytes: Buffer.byteLength(WORKING_TRANSCRIPT),
      truncated: false,
    });
  }
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return ((await response.json()) as { status: string }).status;
}

function parentSystemRequests(harness: TestAppHarness, parentThreadId: string) {
  return listEvents(harness.db, { threadId: parentThreadId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system");
}

async function withHarness(
  run: (harness: TestAppHarness) => Promise<void>,
): Promise<void> {
  const db: DbConnection = createMigratedConnection();
  try {
    await withTestHarness({ db }, run);
  } finally {
    db.$client.close();
  }
}

describe("native thread status liveness", () => {
  it("settles an active thread whose terminal exited as interrupted instead of trusting its working transcript", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "active",
        terminal: "exited-process-exit",
      });

      expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
        "error",
      );
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();

      expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
        "error",
      );
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();
    });
  });

  it("settles a thread whose CLI exited with a non-zero code as error whether it was active or idle", async () => {
    await withHarness(async (harness) => {
      const context = seedNativeContext(harness);
      for (const initialStatus of ["active", "idle"] as const) {
        const { threadId } = seedNativeThread(
          harness,
          { initialStatus, terminal: "exited-process-exit-code-1" },
          context,
        );
        expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
          "error",
        );
      }
    });
  });

  it("does not tell the parent about an idle child whose CLI exited after it finished", async () => {
    await withHarness(async (harness) => {
      const context = seedNativeContext(harness);
      const parent = seedThread(harness.deps, {
        projectId: context.project.id,
        environmentId: context.environment.id,
        status: "idle",
        title: "Parent",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: context.environment.id,
        providerThreadId: "parent-provider-thread",
      });
      const { threadId } = seedNativeThread(
        harness,
        {
          initialStatus: "idle",
          parentThreadId: parent.id,
          terminal: "exited-process-exit",
        },
        context,
      );

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await runPeriodicSweeps({
          ...harness.deps,
          pluginSchedules: harness.pluginService,
          plugins: harness.pluginService,
        });
        await vi.advanceTimersByTimeAsync(5_000);
      } finally {
        vi.useRealTimers();
      }

      expect(getThread(harness.db, threadId)?.status).toBe("error");
      expect(parentSystemRequests(harness, parent.id)).toHaveLength(0);
    });
  });

  it("settles an idle thread whose CLI exited cleanly as error instead of showing it idle", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "exited-process-exit",
      });

      expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
        "error",
      );
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();
    });
  });

  it("reports an error display status in the thread list for an idle thread whose CLI exited cleanly", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "exited-process-exit",
      });

      const listDisplayStatus = async () => {
        const response = await harness.app.request(
          `/api/v1/threads?threadIds=${threadId}`,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          id: string;
          runtime: { displayStatus: string };
        }[];
        return body.find((thread) => thread.id === threadId)?.runtime
          .displayStatus;
      };
      await listDisplayStatus();
      await vi.waitFor(async () =>
        expect(await listDisplayStatus()).toBe("error"),
      );
    });
  });

  it("keeps an idle thread idle while its terminal awaits a daemon reconnect", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "exited-daemon-disconnect",
      });

      expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
        "idle",
      );
    });
  });

  it("keeps an idle thread with a running CLI idle", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "running",
      });
      stampNativeTerminalTranscriptEvidence(harness.db, {
        at: Date.now(),
        nativeSessionId: `session-${threadId}`,
        threadId,
      });

      expect(await readThreadStatus(harness, threadId, "not-expected")).toBe(
        "idle",
      );
    });
  });

  it("still activates an idle thread whose live terminal has a working transcript", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "running",
      });

      expect(await readThreadStatus(harness, threadId, "expected")).toBe(
        "active",
      );
      expect(getNativeTerminalThread(harness.db, threadId)).toMatchObject({
        lastEvidenceKind: "transcript",
      });
    });
  });

  it("settles every dead-terminal native thread in the periodic sweep without opening any thread page", async () => {
    await withHarness(async (harness) => {
      const context = seedNativeContext(harness);
      const seeded: SeededNativeThread[] = [];
      for (let index = 0; index < 12; index += 1) {
        seeded.push(
          seedNativeThread(
            harness,
            { initialStatus: "active", terminal: "exited-process-exit" },
            context,
          ),
        );
      }

      await runPeriodicSweeps({
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      });

      expect(
        seeded.map(({ threadId }) => getThread(harness.db, threadId)?.status),
      ).toEqual(seeded.map(() => "error"));
    });
  });

  it("settles every idle thread whose CLI exited in the periodic sweep", async () => {
    await withHarness(async (harness) => {
      const context = seedNativeContext(harness);
      const exited = seedNativeThread(
        harness,
        { initialStatus: "idle", terminal: "exited-process-exit" },
        context,
      );
      const reconnecting = seedNativeThread(
        harness,
        { initialStatus: "idle", terminal: "exited-daemon-disconnect" },
        context,
      );

      await runPeriodicSweeps({
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      });

      expect(getThread(harness.db, exited.threadId)?.status).toBe("error");
      expect(getThread(harness.db, reconnecting.threadId)?.status).toBe("idle");
    });
  });

  it("tells the parent when a native child is settled because its terminal exited", async () => {
    await withHarness(async (harness) => {
      const context = seedNativeContext(harness);
      const parent = seedThread(harness.deps, {
        projectId: context.project.id,
        environmentId: context.environment.id,
        status: "idle",
        title: "Parent",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: parent.id,
        environmentId: context.environment.id,
        providerThreadId: "parent-provider-thread",
      });
      const { threadId } = seedNativeThread(
        harness,
        {
          initialStatus: "active",
          parentThreadId: parent.id,
          terminal: "exited-process-exit",
        },
        context,
      );
      seedTurnStarted(harness.deps, {
        environmentId: context.environment.id,
        threadId,
        turnId: "native-child-turn",
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await runPeriodicSweeps({
          ...harness.deps,
          pluginSchedules: harness.pluginService,
          plugins: harness.pluginService,
        });
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() =>
          expect(parentSystemRequests(harness, parent.id)).toHaveLength(1),
        );
      } finally {
        vi.useRealTimers();
      }

      expect(
        parentSystemRequests(harness, parent.id)[0]?.systemMessageSubject,
      ).toMatchObject({
        outcomes: [
          {
            threadId,
            status: "interrupted",
            interruption: { reason: "host-daemon-restarted" },
          },
        ],
      });
    });
  });
});
