import { createTerminalSession } from "@bb/db";
import { threadOpenResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function postOpen(
  harness: TestAppHarness,
  threadId: string,
  body: unknown,
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedScopeFixture(harness: TestAppHarness, suffix: string) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-terminal-scope-${suffix}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/terminal-scope-${suffix}`,
  });
  const callerThread = seedThread(harness.deps, { projectId: project.id });
  const otherThread = seedThread(harness.deps, { projectId: project.id });
  const terminalOf = (threadId: string) =>
    createTerminalSession(harness.db, {
      cols: 80,
      daemonSessionId: session.id,
      environmentId: null,
      hostId: host.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId,
      title: "Terminal",
    });
  const viewer = (viewing: string | null) => {
    const socket = createMockHubSocket();
    harness.deps.hub.registerClient(socket, true);
    if (viewing !== null) harness.deps.hub.setDeviceHandoffView(socket, viewing);
    return socket;
  };
  return { callerThread, otherThread, project, terminalOf, viewer };
}

const FOCUS = (terminalId: string) => ({
  file: null,
  terminalAction: { action: "focus", terminalId },
});
const SPLIT = (terminalId: string) => ({
  file: null,
  terminalLayoutAction: { action: "split", terminalId, side: "right" },
});
const OPEN_LINK = (terminalId: string) => ({
  file: null,
  terminalAction: {
    action: "openBrowser",
    terminalId,
    url: "http://localhost:3000",
  },
});
const MOVE = (terminalId: string) => ({
  file: null,
  terminalLayoutAction: {
    action: "move",
    terminalId,
    targetTerminalId: terminalId,
  },
});
const FILE_OPEN = () => ({
  file: { source: "workspace", path: "notes.md", lineNumber: null },
});

describe.each([
  ["focus", FOCUS],
  ["split", SPLIT],
  ["open-link", OPEN_LINK],
  ["move", MOVE],
  ["file open", FILE_OPEN],
])("thread open %s delivery scope", (_name, buildBody) => {
  it("sends nothing to any client when the request names no caller", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `none-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const viewingCaller = fixture.viewer(fixture.callerThread.id);
      const viewingOther = fixture.viewer(fixture.otherThread.id);
      const noView = fixture.viewer(null);

      const response = await postOpen(
        harness,
        fixture.callerThread.id,
        buildBody(terminal.id),
      );

      expect(response.status).toBe(200);
      expect(viewingCaller.messages).toEqual([]);
      expect(viewingOther.messages).toEqual([]);
      expect(noView.messages).toEqual([]);
    });
  });

  it("reaches only clients viewing the caller thread and never another client", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `caller-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const viewingCaller = fixture.viewer(fixture.callerThread.id);
      const viewingOther = fixture.viewer(fixture.otherThread.id);
      const noView = fixture.viewer(null);

      const response = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: fixture.callerThread.id,
      });

      expect(response.status).toBe(200);
      expect(threadOpenResponseSchema.parse(await readJson(response))).toEqual({
        deliveredClients: 1,
        skipReason: null,
      });
      expect(viewingCaller.messages).toHaveLength(1);
      expect(JSON.parse(viewingCaller.messages[0]!)).toMatchObject({
        type: "thread-open",
        threadId: fixture.callerThread.id,
      });
      expect(viewingOther.messages).toEqual([]);
      expect(noView.messages).toEqual([]);
    });
  });

  it("reports why when no client views the caller thread", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `idle-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const viewingOther = fixture.viewer(fixture.otherThread.id);

      const response = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: fixture.callerThread.id,
      });

      expect(response.status).toBe(200);
      expect(threadOpenResponseSchema.parse(await readJson(response))).toEqual({
        deliveredClients: 0,
        skipReason: "no_client_viewing_caller_thread",
      });
      expect(viewingOther.messages).toEqual([]);
    });
  });

  it("reports a missing caller thread as the reason when none is named", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `reason-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      fixture.viewer(fixture.callerThread.id);

      const response = await postOpen(
        harness,
        fixture.callerThread.id,
        buildBody(terminal.id),
      );

      expect(threadOpenResponseSchema.parse(await readJson(response))).toEqual({
        deliveredClients: 0,
        skipReason: "no_caller_thread",
      });
    });
  });

  it("moves only the caller's clients when the terminal belongs to another thread", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `cross-${_name}`);
      const terminal = fixture.terminalOf(fixture.otherThread.id);
      const viewingCaller = fixture.viewer(fixture.callerThread.id);
      const viewingTerminalThread = fixture.viewer(fixture.otherThread.id);

      const response = await postOpen(harness, fixture.otherThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: fixture.callerThread.id,
      });

      expect(response.status).toBe(200);
      expect(viewingCaller.messages).toHaveLength(1);
      expect(JSON.parse(viewingCaller.messages[0]!)).toMatchObject({
        type: "thread-open",
        threadId: fixture.otherThread.id,
      });
      expect(viewingTerminalThread.messages).toEqual([]);
    });
  });

  it("stops reaching a client once it navigates away from the caller thread", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `nav-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const socket = fixture.viewer(fixture.callerThread.id);
      harness.deps.hub.setDeviceHandoffView(socket, fixture.otherThread.id);

      const response = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: fixture.callerThread.id,
      });

      expect(threadOpenResponseSchema.parse(await readJson(response))).toEqual({
        deliveredClients: 0,
        skipReason: "no_client_viewing_caller_thread",
      });
      expect(socket.messages).toEqual([]);
    });
  });

  it("reaches every open app client when all is set", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `all-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const sockets = [
        fixture.viewer(fixture.callerThread.id),
        fixture.viewer(fixture.otherThread.id),
        fixture.viewer(null),
      ];

      const response = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        all: true,
      });

      expect(response.status).toBe(200);
      expect(threadOpenResponseSchema.parse(await readJson(response))).toEqual({
        deliveredClients: 3,
        skipReason: null,
      });
      for (const socket of sockets) expect(socket.messages).toHaveLength(1);
    });
  });

  it("rejects an unknown caller thread and combining all with a caller", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedScopeFixture(harness, `invalid-${_name}`);
      const terminal = fixture.terminalOf(fixture.callerThread.id);
      const socket = fixture.viewer(fixture.callerThread.id);

      const unknown = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: "thr_missing",
      });
      const both = await postOpen(harness, fixture.callerThread.id, {
        ...buildBody(terminal.id),
        callerThreadId: fixture.callerThread.id,
        all: true,
      });

      expect(unknown.status).toBe(404);
      expect(both.status).toBe(400);
      expect(socket.messages).toEqual([]);
    });
  });
});

