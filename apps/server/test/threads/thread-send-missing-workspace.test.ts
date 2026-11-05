import { getThread, listEvents } from "@bb/db";
import { describe, expect, it } from "vitest";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  type createTestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";

type Harness = Awaited<ReturnType<typeof createTestAppHarness>>;

const WORKSPACE_PATH = "/tmp/p19-i29-ws-fixture";
const WORKSPACE_BRANCH = "fix/ws-gone-fixture";
const COPY = `This thread's workspace folder no longer exists: ${WORKSPACE_PATH}. Restore it from branch ${WORKSPACE_BRANCH}, or archive the thread.`;
const OLD_DAEMON_SPAWN_ENOENT =
  'Provider "claude-code" failed to start: spawn /Applications/bb.app/Contents/MacOS/bb ENOENT';
const PATH_NOT_FOUND = `Unmanaged workspace path does not exist: ${WORKSPACE_PATH}`;

interface TurnSubmitFailure {
  errorCode: string;
  errorMessage: string;
}

function seedColdThread(
  harness: Harness,
  failure: TurnSubmitFailure,
  workspaceExists = false,
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host-send-missing-workspace",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
    branchName: WORKSPACE_BRANCH,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-send-missing-workspace",
    threadId: thread.id,
  });
  registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: (request): HostRpcHandlerResult => {
      if (request.command.type === "host.paths_exist") {
        return {
          ok: true,
          result: {
            existence: Object.fromEntries(
              request.command.paths.map((path) => [path, workspaceExists]),
            ),
          },
        };
      }
      if (request.command.type === "host.read_workspace_agent_context") {
        return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
      }
      return { ok: false, ...failure };
    },
  });
  return { thread };
}

function storedErrorMessages(harness: Harness, threadId: string) {
  const events = listEvents(harness.db, { threadId });
  const parse = (type: string) =>
    events
      .filter((event) => event.type === type)
      .map((event) => JSON.parse(event.data ?? "{}").message);
  return {
    rejected: parse("client/turn/rejected"),
    systemError: parse("system/error"),
  };
}

const sendPayload = {
  input: textInput("cold message"),
  mode: "queue-if-active" as const,
  model: "gpt-5",
  permissionMode: "full" as const,
  reasoningLevel: "medium" as const,
  serviceTier: "default" as const,
};

describe("a cold send into a deleted workspace folder", () => {
  it.each([
    {
      name: "the CLI tell from an older daemon that reports a spawn ENOENT",
      errorCode: "missing_executable",
      errorMessage: OLD_DAEMON_SPAWN_ENOENT,
    },
    {
      name: "the CLI tell when the daemon reports path_not_found",
      errorCode: "path_not_found",
      errorMessage: PATH_NOT_FOUND,
    },
  ])(
    "tells $name the workspace is gone",
    async ({ errorCode, errorMessage }) => {
      await withTestHarness(
        { turnAcceptanceGraceMs: 2_000 },
        async (harness) => {
          const { thread } = seedColdThread(harness, {
            errorCode,
            errorMessage,
          });

          const response = await acceptThreadSendRequest(harness.deps, {
            payload: sendPayload,
            thread,
          });

          expect(response).toMatchObject({ refusal: { message: COPY } });
          expect(getThread(harness.db, thread.id)?.status).toBe("error");
          expect(storedErrorMessages(harness, thread.id)).toEqual({
            rejected: [COPY],
            systemError: [COPY],
          });
        },
      );
    },
  );

  it.each([
    {
      name: "a spawn ENOENT from an older daemon",
      errorCode: "missing_executable",
      errorMessage: OLD_DAEMON_SPAWN_ENOENT,
    },
    {
      name: "path_not_found",
      errorCode: "path_not_found",
      errorMessage: PATH_NOT_FOUND,
    },
  ])(
    "shows the composer the workspace copy for $name",
    async ({ errorCode, errorMessage }) => {
      await withTestHarness(
        { turnAcceptanceGraceMs: 2_000 },
        async (harness) => {
          const { thread } = seedColdThread(harness, {
            errorCode,
            errorMessage,
          });

          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}/send`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(sendPayload),
            },
          );

          expect(response.status).toBe(200);
          expect(await readJson(response)).toMatchObject({
            refusal: { message: COPY },
          });
          expect(storedErrorMessages(harness, thread.id).systemError).toEqual([
            COPY,
          ]);
        },
      );
    },
  );

  it("keeps a spawn ENOENT as is when the workspace folder still exists", async () => {
    await withTestHarness({ turnAcceptanceGraceMs: 2_000 }, async (harness) => {
      const { thread } = seedColdThread(
        harness,
        {
          errorCode: "missing_executable",
          errorMessage: OLD_DAEMON_SPAWN_ENOENT,
        },
        true,
      );

      const response = await acceptThreadSendRequest(harness.deps, {
        payload: sendPayload,
        thread,
      });

      expect(response).toMatchObject({
        refusal: { message: OLD_DAEMON_SPAWN_ENOENT },
      });
    });
  });
});
