import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  appendStoredThreadEvent,
  createNativeTerminalThread,
  noopNotifier,
  type DbConnection,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { createMigratedConnection } from "@bb/db/testing";
import { withTestHarness } from "../../helpers/test-app.js";
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

async function readStatus(args: {
  providerId: string;
  initialStatus: "active" | "idle";
  expectedStatus: "active" | "idle";
  priorTurn?: boolean;
  transcript?: string;
}): Promise<void> {
  const db: DbConnection = createMigratedConnection();
  try {
    await withTestHarness({ db }, async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "status-host" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/native-status-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: args.providerId,
        status: args.initialStatus,
      });
      if (args.priorTurn) {
        appendStoredThreadEvent(db, noopNotifier, {
          threadId: thread.id,
          scope: turnScope("completed-old-turn"),
          type: "turn/started",
          data: { providerThreadId: "codex-provider-thread" },
        });
        appendStoredThreadEvent(db, noopNotifier, {
          threadId: thread.id,
          scope: turnScope("completed-old-turn"),
          type: "turn/completed",
          data: {
            providerThreadId: "codex-provider-thread",
            status: "completed",
          },
        });
      }
      createNativeTerminalThread(harness.db, {
        threadId: thread.id,
        providerId: args.providerId,
        nativeSessionId: "legacy-session-123",
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      const responsePromise = harness.app.request(
        `/api/v1/threads/${thread.id}`,
      );
      let capturedCommand = false;
      if (args.transcript !== undefined) {
        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "native_terminal.read_claude_transcript_tail",
          250,
        ).catch(() => null);
        if (
          queued?.command.type === "native_terminal.read_claude_transcript_tail"
        ) {
          capturedCommand = true;
          await reportQueuedCommandSuccess(harness, queued, {
            outcome: "available",
            contentBase64: Buffer.from(args.transcript).toString("base64"),
            sizeBytes: Buffer.byteLength(args.transcript),
            truncated: false,
          });
        }
      }
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        runtime?: {
          nativeActivity?: { confirmation: string; evidenceKind: string };
        };
      };
      expect(body.status).toBe(args.expectedStatus);
      if (args.transcript !== undefined) expect(capturedCommand).toBe(true);
      if (args.expectedStatus === "active" && args.transcript !== undefined) {
        expect(body.runtime?.nativeActivity).toMatchObject({
          confirmation: "confirmed",
          evidenceKind: "transcript",
        });
      }
    });
  } finally {
    db.$client.close();
  }
}

describe("native thread status truth", () => {
  it("G3: changes an active native Codex fixture with no first turn to idle", async () => {
    await readStatus({
      providerId: "codex",
      initialStatus: "active",
      expectedStatus: "idle",
    });
  });

  it("preserves a stale active hook-less Codex session after an earlier turn", async () => {
    await readStatus({
      providerId: "codex",
      initialStatus: "active",
      expectedStatus: "active",
      priorTurn: true,
    });
  });

  it("settles a hook-less Claude session whose transcript ends at turn completion", async () => {
    await readStatus({
      providerId: "claude-code",
      initialStatus: "active",
      expectedStatus: "idle",
      transcript:
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          isSidechain: false,
        }) + "\n",
    });
  });

  it("caches a missing transcript result for the reconciliation window", async () => {
    const db: DbConnection = createMigratedConnection();
    try {
      await withTestHarness({ db }, async (harness) => {
        const { host } = seedHostSession(harness.deps, { id: "status-host" });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/native-status-worktree",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "claude-code",
          status: "active",
        });
        createNativeTerminalThread(harness.db, {
          threadId: thread.id,
          providerId: "claude-code",
          nativeSessionId: "legacy-session-missing",
          initialPrompt: null,
          initialImages: [],
          model: null,
        });
        const firstResponse = harness.app.request(
          `/api/v1/threads/${thread.id}`,
        );
        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "native_terminal.read_claude_transcript_tail",
          250,
        );
        await reportQueuedCommandSuccess(harness, queued, {
          outcome: "missing",
        });
        expect((await firstResponse).status).toBe(200);
        expect(
          (await harness.app.request(`/api/v1/threads/${thread.id}`)).status,
        ).toBe(200);
        const repeatedCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "native_terminal.read_claude_transcript_tail",
          100,
        ).catch(() => null);
        expect(repeatedCommand).toBeNull();
      });
    } finally {
      db.$client.close();
    }
  });

  it("returns the thread list while a transcript RPC is still unanswered", async () => {
    const db: DbConnection = createMigratedConnection();
    try {
      await withTestHarness({ db }, async (harness) => {
        const { host } = seedHostSession(harness.deps, { id: "status-host" });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/native-status-worktree",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "claude-code",
          status: "active",
        });
        createNativeTerminalThread(harness.db, {
          threadId: thread.id,
          providerId: "claude-code",
          nativeSessionId: "legacy-session-list",
          initialPrompt: null,
          initialImages: [],
          model: null,
        });
        const responsePromise = harness.app.request("/api/v1/threads");
        await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "native_terminal.read_claude_transcript_tail",
          1_000,
        );
        const response = await Promise.race([
          responsePromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
        ]);
        expect(response).not.toBeNull();
        expect(response?.status).toBe(200);
      });
    } finally {
      db.$client.close();
    }
  });

  it("G4: confirms Working for a hook-less Claude session with an assistant turn in progress", async () => {
    await readStatus({
      providerId: "claude-code",
      initialStatus: "idle",
      expectedStatus: "active",
      transcript:
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
        "\n",
    });
  });
});
