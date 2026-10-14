import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createTerminalSession,
  getTerminalAttention,
} from "@bb/db";
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
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

describe("terminal attention persistence", () => {
  it("keeps unread attention and its sequence through a database restart", async () => {
    const original = await createTestAppHarness();
    harnesses.push(original);
    const { daemonSessionId, hostId, terminalId, threadId } =
      createAttentionTerminal(original);

    original.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId,
      sessionId: daemonSessionId,
      message: {
        type: "terminal.attention",
        terminalId,
        seq: 17,
        kind: "bell",
        body: "Tests passed",
        title: "Build finished",
      },
    });
    const beforeRestart = await getTerminalApiAttention(
      original,
      threadId,
      terminalId,
    );
    const serialized = original.db.$client.serialize();
    const restarted = await createTestAppHarness({
      db: createConnection(serialized),
    });
    harnesses.push(restarted);

    expect(
      await getTerminalApiAttention(restarted, threadId, terminalId),
    ).toEqual(beforeRestart);
  });

  it("keeps a cleared attention cleared through a database restart", async () => {
    const original = await createTestAppHarness();
    harnesses.push(original);
    const { terminalId, threadId } = createAttentionTerminal(original);
    original.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { body: "Tests passed", title: "Build finished" },
    });
    expect(getTerminalAttention(original.db, terminalId)).toMatchObject({
      seq: 1,
      clearedAt: null,
    });
    original.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket: { close() {}, send() {} },
      message: { type: "visibility", visible: true },
    });
    expect(getTerminalAttention(original.db, terminalId)).toMatchObject({
      seq: 1,
      clearedAt: expect.any(Number),
    });
    const serialized = original.db.$client.serialize();
    const restarted = await createTestAppHarness({
      db: createConnection(serialized),
    });
    harnesses.push(restarted);

    expect(
      await getTerminalApiAttention(restarted, threadId, terminalId),
    ).toBeNull();
  });
});

function createAttentionTerminal(harness: TestAppHarness): {
  daemonSessionId: string;
  hostId: string;
  terminalId: string;
  threadId: string;
} {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
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
    title: "Build terminal",
  });
  return {
    daemonSessionId: session.id,
    hostId: host.id,
    terminalId: terminal.id,
    threadId: thread.id,
  };
}

async function getTerminalApiAttention(
  harness: TestAppHarness,
  threadId: string,
  terminalId: string,
): Promise<unknown> {
  const response = await harness.app.request(
    `/api/v1/terminals?threadId=${threadId}`,
  );
  expect(response.status).toBe(200);
  const payload: unknown = await response.json();
  expect(typeof payload).toBe("object");
  expect(payload).not.toBeNull();
  const sessions = (payload as { sessions: Array<Record<string, unknown>> })
    .sessions;
  return sessions.find((session) => session.id === terminalId)?.attention;
}
