import { createNativeTerminalThread, getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import { reconcileDaemonReportedThreads } from "../../src/services/threads/thread-lifecycle.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedNativeAndChatThreads(harness: TestAppHarness) {
  const { host, project, environment, thread: chat } = seedThreadFixture(
    harness,
    { thread: { status: "active" } },
  );
  const native = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  createNativeTerminalThread(harness.db, {
    threadId: native.id,
    providerId: "codex",
    nativeSessionId: null,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  return { chat, host, native };
}

describe("reconnect of the same daemon instance", () => {
  it("keeps a native terminal thread running while interrupting a chat thread the daemon no longer reports", async () => {
    await withTestHarness(async (harness) => {
      const { chat, host, native } = seedNativeAndChatThreads(harness);

      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: true,
      });

      expect(getThread(harness.db, native.id)?.status).toBe("active");
      expect(getThread(harness.db, chat.id)?.status).not.toBe("active");
    });
  });

  it("still interrupts a native terminal thread when the daemon process restarted", async () => {
    await withTestHarness(async (harness) => {
      const { host, native } = seedNativeAndChatThreads(harness);

      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: false,
      });

      expect(getThread(harness.db, native.id)?.status).not.toBe("active");
    });
  });
});
