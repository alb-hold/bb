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
import { clearNativeTerminalStateOnExit } from "./native-terminal-activity.js";

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("native terminal row state", () => {
  it("clears the row state when the native terminal exits", async () => {
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

    clearNativeTerminalStateOnExit(harness.deps, {
      closeReason: "process-exit",
      id: terminal.id,
      threadId: thread.id,
    });

    expect(getThreadRowState(harness.db, thread.id)).toEqual({
      statuses: {},
      progress: null,
    });
  });
});
