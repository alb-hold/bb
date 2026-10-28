import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  createNativeTerminalThread,
  createTerminalSession,
  getNativeTerminalThread,
  getThread,
  setNativeTerminalThreadTerminal,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
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
} from "../../helpers/seed.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
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

type TerminalState = "running" | "exited-process-exit";

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
  if (args.terminal === "exited-process-exit") {
    harness.db.$client
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited', close_reason = 'process-exit', exit_code = 0 WHERE id = ?",
      )
      .run(terminal.id);
  }
  return { threadId: thread.id };
}

async function readThreadStatus(
  harness: TestAppHarness,
  threadId: string,
): Promise<string> {
  const responsePromise = harness.app.request(`/api/v1/threads/${threadId}`);
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) => command.type === "native_terminal.read_transcript_tail",
    250,
  ).catch(() => null);
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
  it("settles an active thread whose terminal exited instead of trusting its working transcript", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "active",
        terminal: "exited-process-exit",
      });

      expect(await readThreadStatus(harness, threadId)).toBe("idle");
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();

      expect(await readThreadStatus(harness, threadId)).toBe("idle");
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();
    });
  });

  it("keeps an idle thread with an exited terminal idle when its transcript still says working", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "exited-process-exit",
      });

      expect(await readThreadStatus(harness, threadId)).toBe("idle");
      expect(
        getNativeTerminalThread(harness.db, threadId)?.lastEvidenceAt,
      ).toBeNull();
    });
  });

  it("still activates an idle thread whose live terminal has a working transcript", async () => {
    await withHarness(async (harness) => {
      const { threadId } = seedNativeThread(harness, {
        initialStatus: "idle",
        terminal: "running",
      });

      expect(await readThreadStatus(harness, threadId)).toBe("active");
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
      ).toEqual(seeded.map(() => "idle"));
    });
  });
});
