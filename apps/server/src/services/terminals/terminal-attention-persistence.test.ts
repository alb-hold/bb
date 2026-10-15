import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createTerminalSession,
  getTerminalAttention,
  getThread,
  migrate,
  updateTerminalSession,
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
  it("includes unread persisted attention in a WebSocket attach snapshot", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);
    const { terminalId } = createAttentionTerminal(harness);
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { body: "Tests passed", title: "Build finished" },
    });
    updateTerminalSession(harness.db, {
      scope: { kind: "terminal", terminalId },
      update: { closeReason: "process-exit", kind: "exit" },
    });
    const sent: string[] = [];
    const socket = {
      close() {},
      send(data: string) {
        sent.push(data);
      },
    };

    harness.deps.terminalSessions.attachBrowserTerminal({
      outputAcks: false,
      resizeAcks: false,
      socket,
      sinceSeq: 0,
      terminalId,
    });

    const attached = sent
      .map((data) => JSON.parse(data) as Record<string, unknown>)
      .find((message) => message.type === "attached");
    expect(attached?.session).toMatchObject({
      attention: {
        body: "Tests passed",
        kind: "osc-9",
        seq: 1,
        title: "Build finished",
      },
    });
  });

  it("keeps daemon attention cleared while the terminal is visible", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { daemonSessionId, hostId, terminalId, threadId } =
      createAttentionTerminal(harness);
    const latestAttentionAt = getThread(
      harness.db,
      threadId,
    )?.latestAttentionAt;
    const socket = { close() {}, send() {} };
    harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket,
      message: { type: "visibility", visible: true },
    });

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId,
      sessionId: daemonSessionId,
      message: {
        type: "terminal.attention",
        terminalId,
        seq: 1,
        kind: "bell",
        title: "visible daemon signal",
      },
    });

    expect(
      getTerminalAttention(harness.db, terminalId)?.clearedAt,
    ).not.toBeNull();
    expect(
      await getTerminalApiAttention(harness, threadId, terminalId),
    ).toBeNull();
    expect(getThread(harness.db, threadId)?.latestAttentionAt).toBe(
      latestAttentionAt,
    );
  });

  it("keeps API attention cleared while the terminal is visible", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { terminalId, threadId } = createAttentionTerminal(harness);
    const latestAttentionAt = getThread(
      harness.db,
      threadId,
    )?.latestAttentionAt;
    harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket: { close() {}, send() {} },
      message: { type: "visibility", visible: true },
    });

    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "visible API signal" },
    });

    expect(
      getTerminalAttention(harness.db, terminalId)?.clearedAt,
    ).not.toBeNull();
    expect(
      await getTerminalApiAttention(harness, threadId, terminalId),
    ).toBeNull();
    expect(getThread(harness.db, threadId)?.latestAttentionAt).toBe(
      latestAttentionAt,
    );
  });

  it("keeps daemon attention unread while the terminal is hidden", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { daemonSessionId, hostId, terminalId, threadId } =
      createAttentionTerminal(harness);
    harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket: { close() {}, send() {} },
      message: { type: "visibility", visible: false },
    });

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId,
      sessionId: daemonSessionId,
      message: {
        type: "terminal.attention",
        terminalId,
        seq: 1,
        kind: "bell",
        title: "hidden daemon signal",
      },
    });

    expect(getTerminalAttention(harness.db, terminalId)?.clearedAt).toBeNull();
    expect(
      await getTerminalApiAttention(harness, threadId, terminalId),
    ).toMatchObject({
      seq: 1,
      title: "hidden daemon signal",
    });
  });

  it("keeps daemon ordering independent from direct notifications", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { daemonSessionId, hostId, terminalId } =
      createAttentionTerminal(harness);
    const daemonAttention = (seq: number) =>
      harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId,
        sessionId: daemonSessionId,
        message: {
          type: "terminal.attention",
          terminalId,
          seq,
          kind: "bell",
          title: `daemon-${seq}`,
        },
      });

    daemonAttention(7);
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 7,
      title: "daemon-7",
    });
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "api-1" },
    });
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 8,
      title: "api-1",
    });
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "api-2" },
    });
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 9,
      title: "api-2",
    });
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "api-3" },
    });
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 10,
      title: "api-3",
    });

    daemonAttention(8);
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 11,
      title: "daemon-8",
    });
    daemonAttention(8);
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 11,
      title: "daemon-8",
    });
    daemonAttention(9);
    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      seq: 12,
      title: "daemon-9",
    });
  });

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
