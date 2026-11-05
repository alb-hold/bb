import { describe, expect, it } from "vitest";
import {
  createEnvironment,
  createProject,
  createThread,
  listEvents,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { HostDaemonCommandForType } from "../../../src/internal/command-result-side-effects.js";
import { settleTurnSubmitCommandResult } from "../../../src/services/threads/thread-lifecycle.js";
import { testLogger } from "../../helpers/test-app.js";

function runFailure(
  errorCode: string,
  errorMessage: string,
  branchName: string | null,
) {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    id: "host-thread-command-failure-copy",
    name: "Thread Command Failure Copy Host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "Thread Command Failure Copy Project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/thread-command-failure-copy",
    },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/thread-command-failure-copy/worktree",
    isGitRepo: branchName !== null,
    branchName,
    providerOwnsPath: false,
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "active",
  });
  const command = {
    type: "turn.submit",
    threadId: thread.id,
    environmentId: environment.id,
    requestId: "req-thread-command-failure-copy",
    target: { mode: "start" },
  } as HostDaemonCommandForType<"turn.submit">;

  db.transaction((tx) => {
    settleTurnSubmitCommandResult({
      command,
      deps: { db: tx, hub: noopNotifier, logger: testLogger },
      execution: {
        createdAt: Date.now(),
        hostId: host.id,
        id: "execution-thread-command-failure-copy",
      },
      report: {
        type: "turn.submit",
        ok: false,
        errorCode,
        errorMessage,
        completedAt: Date.now(),
        executionId: "execution-thread-command-failure-copy",
      },
    });
  });

  const errorEvent = listEvents(db, { threadId: thread.id }).find(
    (event) => event.type === "system/error",
  );
  const data = errorEvent ? JSON.parse(errorEvent.data ?? "{}") : null;
  db.$client.close();
  return data;
}

describe("thread command failure copy", () => {
  it("names a deleted workspace path and its branch recovery action", () => {
    const data = runFailure(
      "path_not_found",
      "Unmanaged workspace path does not exist: /private/tmp/wt-slack-sender-fanout",
      "fix/slack-sender-fanout",
    );

    expect(data?.message).toBe(
      "This thread's workspace folder no longer exists: /private/tmp/wt-slack-sender-fanout. Restore it from branch fix/slack-sender-fanout, or archive the thread.",
    );
  });

  it("keeps the generic message for other command errors", () => {
    const data = runFailure("provider_rpc_error", "provider failed", null);

    expect(data?.message).toBe("Command turn.submit failed");
  });
});
