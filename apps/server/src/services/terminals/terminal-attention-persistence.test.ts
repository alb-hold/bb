import { afterEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import {
  createConnection,
  createTerminalSession,
  getDeviceHandoffAttentionMarker,
  getTerminalAttention,
  upsertTerminalAttention,
  getThread,
  updateTerminalSession,
} from "@bb/db";
import { TERMINAL_ATTENTION_CONTRACT_CASES } from "@bb/test-helpers";
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
  it("uses the public API host guard and rejects unknown clear targets", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { terminalId } = createAttentionTerminal(harness);
    upsertTerminalAttention(harness.db, {
      terminalSessionId: terminalId,
      seq: 1,
      daemonSeq: null,
      kind: "bell",
      title: "Build finished",
      body: null,
      attentionAt: Date.now(),
    });

    const deniedRequests = [
      ["GET", "/api/v1/terminals"],
      ["GET", "/api/v1/terminals/attention"],
      ["POST", `/api/v1/terminals/${terminalId}/attention/clear`],
    ] as const;
    for (const [method, path] of deniedRequests) {
      const response = await harness.app.request(path, {
        method,
        headers: { host: "untrusted.invalid" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden_host" });
    }

    const listed = await harness.app.request("/api/v1/terminals/attention", {
      headers: { host: "localhost" },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      sessions: [expect.objectContaining({ id: terminalId })],
    });

    const cleared = await harness.app.request(
      `/api/v1/terminals/${terminalId}/attention/clear`,
      { method: "POST", headers: { host: "localhost" } },
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      id: terminalId,
      attention: null,
    });

    const unknown = await harness.app.request(
      "/api/v1/terminals/term_unknown/attention/clear",
      { method: "POST", headers: { host: "localhost" } },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "terminal_not_found" });
  });

  it.each(TERMINAL_ATTENTION_CONTRACT_CASES)(
    "follows the shared terminal attention contract: $name",
    async (contract) => {
      const harness = await createTestAppHarness();
      harnesses.push(harness);
      const terminalIds = new Map<string, string>();
      for (const entry of contract.sessions) {
        const { terminalId } = createAttentionTerminal(harness);
        terminalIds.set(entry.id, terminalId);
        upsertTerminalAttention(harness.db, {
          terminalSessionId: terminalId,
          seq: entry.seq,
          daemonSeq: null,
          kind: "bell",
          title: entry.title,
          body: null,
          attentionAt: entry.attentionAt,
        });
      }

      const listed = await harness.app.request("/api/v1/terminals/attention");
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(
        listedBody.sessions.map(
          ({ id }) =>
            [...terminalIds.entries()].find(
              ([, terminalId]) => terminalId === id,
            )?.[0],
        ),
      ).toEqual(contract.unreadIds);

      if (contract.nextId !== null) {
        const clearId = terminalIds.get(contract.clearId ?? "");
        expect(clearId).toBeDefined();
        const cleared = await harness.app.request(
          `/api/v1/terminals/${clearId}/attention/clear`,
          { method: "POST" },
        );
        expect(cleared.status).toBe(200);
        expect(await cleared.json()).toMatchObject({ attention: null });
        const afterClear = (await (
          await harness.app.request("/api/v1/terminals/attention")
        ).json()) as { sessions: Array<{ id: string }> };
        expect(
          afterClear.sessions.map(
            ({ id }) =>
              [...terminalIds.entries()].find(
                ([, terminalId]) => terminalId === id,
              )?.[0],
          ),
        ).toEqual(contract.unreadIdsAfterClear);
      }
    },
  );

  it("includes unread persisted attention in a WebSocket attach snapshot", async () => {
    const db = createMigratedConnection();
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

    harness.hub.registerTerminalClient(terminalId, socket);
    const renamed = harness.deps.terminalSessions.renameTerminal({
      terminalId,
      payload: { title: "Renamed build terminal" },
    });
    expect(renamed.attention).toMatchObject({
      body: "Tests passed",
      kind: "osc-9",
      seq: 1,
      title: "Build finished",
    });
    expect(
      sent
        .map((data) => JSON.parse(data) as Record<string, unknown>)
        .find((message) => message.type === "session-updated")?.session,
    ).toMatchObject({
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

  it("publishes the cleared attention on the visible client session update", async () => {
    const db = createMigratedConnection();
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);
    const { terminalId } = createAttentionTerminal(harness);
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "hidden signal" },
    });
    const sent: string[] = [];
    const socket = {
      close() {},
      send(data: string) {
        sent.push(data);
      },
    };
    harness.hub.registerTerminalClient(terminalId, socket);

    harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket,
      message: { type: "visibility", visible: true },
    });

    expect(
      getTerminalAttention(harness.db, terminalId)?.clearedAt,
    ).not.toBeNull();
    expect(
      sent
        .map((data) => JSON.parse(data) as Record<string, unknown>)
        .find((message) => message.type === "session-updated")?.session,
    ).toMatchObject({ attention: null, id: terminalId });
  });

  it("keeps pending attention when a second client attaches hidden", async () => {
    const db = createMigratedConnection();
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);
    const { terminalId } = createAttentionTerminal(harness);
    harness.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { title: "hidden before attach" },
    });
    const socket = { close() {}, send() {} };
    harness.hub.registerTerminalClient(terminalId, socket);

    harness.deps.terminalSessions.handleBrowserTerminalMessage({
      terminalId,
      socket,
      message: { type: "visibility", visible: false },
    });

    expect(getTerminalAttention(harness.db, terminalId)).toMatchObject({
      clearedAt: null,
      title: "hidden before attach",
    });
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

  it("clears dropped handoff attention on restart without delivering the lost payload", async () => {
    const original = await createTestAppHarness();
    harnesses.push(original);
    const { terminalId, threadId } = createAttentionTerminal(original);
    expect(
      original.hub.notifyDeviceHandoff(
        {
          kind: "copy-text",
          text: "restart-private-copy",
          origin: { threadId, terminalSessionId: terminalId },
        },
        "Build terminal",
      ),
    ).toBe(0);
    expect(getTerminalAttention(original.db, terminalId)).toMatchObject({
      body: "",
      title: "Link waiting for this device",
      clearedAt: null,
    });
    expect(getDeviceHandoffAttentionMarker(original.db, terminalId)).toEqual({
      terminalSessionId: terminalId,
      attentionSeq: 1,
    });
    expect(
      JSON.stringify({
        attention: getTerminalAttention(original.db, terminalId),
        marker: getDeviceHandoffAttentionMarker(original.db, terminalId),
      }),
    ).not.toContain("restart-private-copy");

    const restarted = await restartTestAppHarness(
      original,
      original.db.$client.serialize(),
    );
    expect(getTerminalAttention(restarted.db, terminalId)?.clearedAt).toEqual(
      expect.any(Number),
    );
    expect(
      getDeviceHandoffAttentionMarker(restarted.db, terminalId),
    ).toBeNull();
    const laterViewer = {
      messages: [] as string[],
      close() {},
      send(message: string) {
        this.messages.push(message);
      },
    };
    restarted.hub.subscribe(laterViewer, { kind: "thread-detail", threadId });
    restarted.hub.setDeviceHandoffView(laterViewer, threadId);
    expect(laterViewer.messages).toHaveLength(0);
    expect(
      getDeviceHandoffAttentionMarker(restarted.db, terminalId),
    ).toBeNull();
  });

  it("preserves a real OSC-9 attention that replaced a handoff before restart", async () => {
    const original = await createTestAppHarness();
    harnesses.push(original);
    const { terminalId, threadId } = createAttentionTerminal(original);
    original.deps.terminalSessions.setDeviceHandoffAttention(terminalId, true);
    original.deps.terminalSessions.notifyTerminal({
      terminalId,
      payload: { body: "Tests passed", title: "Build finished" },
    });
    expect(getTerminalAttention(original.db, terminalId)).toMatchObject({
      body: "Tests passed",
      seq: 2,
      title: "Build finished",
    });

    const restarted = await restartTestAppHarness(
      original,
      original.db.$client.serialize(),
    );
    expect(getTerminalAttention(restarted.db, terminalId)).toMatchObject({
      body: "Tests passed",
      clearedAt: null,
      seq: 2,
      title: "Build finished",
    });
    expect(
      getDeviceHandoffAttentionMarker(restarted.db, terminalId),
    ).toBeNull();
    expect(
      await getTerminalApiAttention(restarted, threadId, terminalId),
    ).toMatchObject({ body: "Tests passed", title: "Build finished" });
  });

  it("clears only the handoff attention when its terminal exits", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const { daemonSessionId, hostId, terminalId, threadId } =
      createAttentionTerminal(harness);
    harness.deps.terminalSessions.setDeviceHandoffAttention(terminalId, true);
    expect(getDeviceHandoffAttentionMarker(harness.db, terminalId)).toEqual({
      terminalSessionId: terminalId,
      attentionSeq: 1,
    });

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId,
      sessionId: daemonSessionId,
      message: {
        type: "terminal.exited",
        terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    expect(getTerminalAttention(harness.db, terminalId)?.clearedAt).toEqual(
      expect.any(Number),
    );
    expect(getDeviceHandoffAttentionMarker(harness.db, terminalId)).toBeNull();
    expect(
      await getTerminalApiAttention(harness, threadId, terminalId),
    ).toBeUndefined();
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

async function restartTestAppHarness(
  previous: TestAppHarness,
  serializedDb: Buffer,
): Promise<TestAppHarness> {
  const previousIndex = harnesses.indexOf(previous);
  if (previousIndex >= 0) harnesses.splice(previousIndex, 1);
  await previous.cleanup();
  previous.db.$client.close();
  const restarted = await createTestAppHarness({
    db: createConnection(serializedDb),
  });
  harnesses.push(restarted);
  return restarted;
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
