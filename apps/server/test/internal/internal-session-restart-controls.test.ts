import {
  createNativeTerminalThread,
  createTerminalSession,
  getThread,
  listEvents,
  setNativeTerminalThreadTerminal,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function eventTypes(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.type !== "turn/started")
    .map((row) => row.type);
}

describe("a real daemon restart", () => {
  it("spares a native thread awaiting reattach and an adopted chat turn while still interrupting an unadopted chat turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, project, environment, thread } = seedThreadFixture(
        harness,
        { thread: { status: "active" } },
      );
      const adopted = thread;
      const unadopted = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: adopted.id,
        turnId: "turn-adopted",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: unadopted.id,
        turnId: "turn-unadopted",
      });
      const native = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      createNativeTerminalThread(harness.db, {
        threadId: native.id,
        providerId: "codex",
        nativeSessionId: "native-session-1",
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      const terminal = createTerminalSession(harness.db, {
        threadId: native.id,
        environmentId: environment.id,
        hostId: host.id,
        daemonSessionId: session.id,
        title: "Codex",
        initialCwd: "/tmp",
        cols: 120,
        rows: 36,
        status: "running",
      });
      setNativeTerminalThreadTerminal(harness.db, {
        threadId: native.id,
        terminalSessionId: terminal.id,
      });

      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-restart-controls",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          adoptedThreads: [
            { threadId: adopted.id, activeTurnId: "turn-adopted" },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, native.id)?.status).toBe("active");
      expect(eventTypes(harness, native.id)).toEqual([]);
      expect(getThread(harness.db, adopted.id)?.status).toBe("active");
      expect(eventTypes(harness, adopted.id)).toEqual([]);
      expect(getThread(harness.db, unadopted.id)?.status).toBe("error");
      expect(eventTypes(harness, unadopted.id)).toEqual([
        "turn/completed",
        "system/error",
        "system/thread/interrupted",
      ]);
    });
  });
});
