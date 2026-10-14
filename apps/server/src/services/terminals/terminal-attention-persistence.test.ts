import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createTerminalSession,
  getTerminalSession,
} from "@bb/db";
import {
  seedHost,
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
    const { terminalId, threadId } = createAttentionTerminal(original);

    original.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { body: "Tests passed", title: "Build finished" },
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
    expect(
      typeof getTerminalSession(original.db, { kind: "terminal", terminalId })
        ?.attentionJson,
    ).toBe("string");
    original.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket: { close() {}, send() {} },
      message: { type: "visibility", visible: true },
    });
    expect(
      getTerminalSession(original.db, { kind: "terminal", terminalId })
        ?.attentionJson,
    ).toBeNull();
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

function createAttentionTerminal(
  harness: TestAppHarness,
): { terminalId: string; threadId: string } {
  const host = seedHost(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = seedThread(harness.deps, { projectId: project.id });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    daemonSessionId: null,
    environmentId: null,
    hostId: host.id,
    initialCwd: "/tmp",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Build terminal",
  });
  return { terminalId: terminal.id, threadId: thread.id };
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
