import { createNativeTerminalThread, getThread, listEvents } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const DAEMON_INSTANCE_ID = "instance-1";

function seedThreads(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    session: undefined,
    thread: { status: "active" },
  });
  const seedActive = () =>
    seedThread(harness.deps, {
      projectId: fixture.project.id,
      environmentId: fixture.environment.id,
      status: "active",
    });
  const native = seedActive();
  createNativeTerminalThread(harness.db, {
    threadId: native.id,
    providerId: "codex",
    nativeSessionId: null,
    initialPrompt: null,
    model: null,
  });
  return {
    host: fixture.host,
    session: fixture.session,
    native,
    reportedChat: fixture.thread,
    unreportedChat: seedActive(),
  };
}

function reconnect(
  harness: TestAppHarness,
  args: {
    activeThreadIds: string[];
    host: { id: string; name: string };
    instanceId: string;
    sessionId: string;
  },
) {
  handleDaemonSocketClosed(harness.deps, { sessionId: args.sessionId });
  return harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.host.id }),
    body: JSON.stringify({
      hostId: args.host.id,
      instanceId: args.instanceId,
      hostName: args.host.name,
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: "/tmp/host-daemon-reconnect",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: args.activeThreadIds.map((threadId) => ({ threadId })),
      undeliveredEventThreadIds: [],
    }),
  });
}

function interruptions(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.type === "system/thread/interrupted")
    .map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

describe("a daemon session that reopens after its socket dropped", () => {
  it("with the same instance id keeps native and reported threads active and interrupts only the unreported chat thread", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, native, reportedChat, unreportedChat } =
        seedThreads(harness);

      const response = await reconnect(harness, {
        activeThreadIds: [reportedChat.id],
        host,
        instanceId: DAEMON_INSTANCE_ID,
        sessionId: session.id,
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, native.id)?.status).toBe("active");
      expect(interruptions(harness, native.id)).toEqual([]);
      expect(getThread(harness.db, reportedChat.id)?.status).toBe("active");
      expect(interruptions(harness, reportedChat.id)).toEqual([]);
      expect(getThread(harness.db, unreportedChat.id)?.status).not.toBe(
        "active",
      );
      expect(interruptions(harness, unreportedChat.id)).toEqual([
        { reason: "host-daemon-restarted", cause: "host-connection-lost" },
      ]);
    });
  });

  it("with a different instance id interrupts the native thread as a daemon restart", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, native, reportedChat } = seedThreads(harness);

      const response = await reconnect(harness, {
        activeThreadIds: [reportedChat.id],
        host,
        instanceId: "instance-restarted",
        sessionId: session.id,
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, native.id)?.status).not.toBe("active");
      expect(interruptions(harness, native.id)).toEqual([
        { reason: "host-daemon-restarted" },
      ]);
    });
  });
});
