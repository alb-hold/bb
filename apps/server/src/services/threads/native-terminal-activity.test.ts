import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeTerminalThread,
  createTerminalSession,
  getThreadRowState,
  putThreadRowState,
  setNativeTerminalThreadTerminal,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../../test/helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../../test/helpers/test-app.js";

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("native terminal row state", () => {
  it.each(["process-exit", "user"] as const)(
    "clears row state through terminal lifecycle when the native terminal closes with %s",
    async (closeReason) => {
      const harness = await createTestAppHarness({
        db: createMigratedConnection(),
      });
      harnesses.push(harness);
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        environmentId: null,
        hostId: host.id,
        daemonSessionId: session.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Native terminal",
      });
      createNativeTerminalThread(harness.db, {
        threadId: thread.id,
        providerId: thread.providerId,
        nativeSessionId: "native-session",
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      setNativeTerminalThreadTerminal(harness.db, {
        threadId: thread.id,
        terminalSessionId: terminal.id,
      });
      putThreadRowState(harness.db, thread.id, {
        statuses: { task: { value: "Working" } },
        progress: { value: 0.4 },
      });

      harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: host.id,
        sessionId: session.id,
        message: {
          type: "terminal.exited",
          terminalId: terminal.id,
          exitCode: 0,
          closeReason,
        },
      });

      expect(getThreadRowState(harness.db, thread.id)).toEqual({
        statuses: {},
        progress: null,
      });
    },
  );

  it("keeps row state when the daemon disconnects and the terminal can reattach", async () => {
    const harness = await createTestAppHarness({
      db: createMigratedConnection(),
    });
    harnesses.push(harness);
    const { host, session } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const thread = seedThread(harness.deps, { projectId: project.id });
    const terminal = createTerminalSession(harness.db, {
      cols: 80,
      environmentId: null,
      hostId: host.id,
      daemonSessionId: session.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: thread.id,
      title: "Native terminal",
    });
    createNativeTerminalThread(harness.db, {
      threadId: thread.id,
      providerId: thread.providerId,
      nativeSessionId: "native-session",
      initialPrompt: null,
      initialImages: [],
      model: null,
    });
    setNativeTerminalThreadTerminal(harness.db, {
      threadId: thread.id,
      terminalSessionId: terminal.id,
    });
    const rowState = {
      statuses: { task: { value: "Working" } },
      progress: { value: 0.4 },
    };
    putThreadRowState(harness.db, thread.id, rowState);

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: host.id,
      sessionId: session.id,
      message: {
        type: "terminal.exited",
        terminalId: terminal.id,
        exitCode: null,
        closeReason: "daemon-disconnect",
      },
    });

    expect(getThreadRowState(harness.db, thread.id)).toEqual(rowState);
  });
});
