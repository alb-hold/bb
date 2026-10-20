import { eq } from "drizzle-orm";
import { createTerminalSession, getThread, threads } from "@bb/db";
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

async function postPaneAction(
  harness: TestAppHarness,
  threadId: string,
  body: unknown,
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/pane-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("public thread open", () => {
  it("broadcasts an open-file signal to connected clients without persisting", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-open",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-open-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });

      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const before = getThread(harness.db, thread.id);

      const response = await postOpen(harness, thread.id, {
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      });

      expect(response.status).toBe(200);
      const body = threadOpenResponseSchema.parse(await readJson(response));
      expect(body).toEqual({ delivered: 1 });

      expect(socket.messages).toHaveLength(1);
      expect(JSON.parse(socket.messages[0])).toEqual({
        type: "thread-open",
        projectId: project.id,
        threadId: thread.id,
        split: "replace",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: 42,
        },
      });

      expect(getThread(harness.db, thread.id)).toEqual(before);
    });
  });

  it("rejects unsafe paths and sends nothing", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-open-bad",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-open-bad-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });

      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const response = await postOpen(harness, thread.id, {
        file: {
          source: "workspace",
          path: "../escape.ts",
          lineNumber: null,
        },
      });

      expect(response.status).toBe(400);
      expect(socket.messages).toHaveLength(0);
    });
  });

  it("returns 404 for an unknown thread", async () => {
    await withTestHarness(async (harness) => {
      const response = await postOpen(harness, "thr_missing", {
        split: "replace",
        file: {
          source: "workspace",
          path: "src/index.ts",
          lineNumber: null,
        },
      });

      expect(response.status).toBe(404);
    });
  });

  it("opens a hidden thread through the ordinary direct path", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-open-hidden",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-open-hidden-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        visibility: "hidden",
      });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const response = await postOpen(harness, thread.id, { file: null });
      expect(response.status).toBe(200);
      expect(JSON.parse(socket.messages[0]!)).toMatchObject({
        type: "thread-open",
        projectId: project.id,
        threadId: thread.id,
      });
    });
  });

  it("opens a thread without a file and validates split placement", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-open-split",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-open-split-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const response = await postOpen(harness, thread.id, {
        split: "right",
        file: null,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(socket.messages[0]!)).toEqual({
        type: "thread-open",
        projectId: project.id,
        threadId: thread.id,
        split: "right",
        file: null,
      });

      const invalid = await postOpen(harness, thread.id, {
        split: "diagonal",
        file: null,
      });
      expect(invalid.status).toBe(400);
      expect(socket.messages).toHaveLength(1);
    });
  });

  it("broadcasts terminal focus and browser actions only for that thread's terminal", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-thread-terminal-action",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-terminal-action-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const otherThread = seedThread(harness.deps, { projectId: project.id });
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Thread terminal",
      });
      const targetTerminal = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Target terminal",
      });
      const foreignTarget = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: otherThread.id,
        title: "Foreign terminal",
      });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const focus = await postOpen(harness, thread.id, {
        file: null,
        terminalAction: { action: "focus", terminalId: terminal.id },
      });
      expect(focus.status).toBe(200);
      expect(JSON.parse(socket.messages[0]!)).toMatchObject({
        type: "thread-open",
        threadId: thread.id,
        terminalAction: { action: "focus", terminalId: terminal.id },
      });

      const browser = await postOpen(harness, thread.id, {
        file: null,
        terminalAction: {
          action: "openBrowser",
          terminalId: terminal.id,
          url: "http://localhost:3000",
        },
      });
      expect(browser.status).toBe(200);
      expect(JSON.parse(socket.messages[1]!)).toMatchObject({
        terminalAction: {
          action: "openBrowser",
          terminalId: terminal.id,
          url: "http://localhost:3000",
        },
      });

      const split = await postOpen(harness, thread.id, {
        file: null,
        terminalLayoutAction: {
          action: "split",
          terminalId: terminal.id,
          side: "right",
        },
      });
      const move = await postOpen(harness, thread.id, {
        file: null,
        terminalLayoutAction: {
          action: "move",
          terminalId: terminal.id,
          targetTerminalId: targetTerminal.id,
        },
      });
      const foreignMove = await postOpen(harness, thread.id, {
        file: null,
        terminalLayoutAction: {
          action: "move",
          terminalId: terminal.id,
          targetTerminalId: foreignTarget.id,
        },
      });
      expect(split.status).toBe(200);
      expect(move.status).toBe(200);
      expect(JSON.parse(socket.messages[2]!)).toMatchObject({
        terminalLayoutAction: {
          action: "split",
          terminalId: terminal.id,
          side: "right",
        },
      });
      expect(JSON.parse(socket.messages[3]!)).toMatchObject({
        terminalLayoutAction: {
          action: "move",
          terminalId: terminal.id,
          targetTerminalId: targetTerminal.id,
        },
      });

      const foreign = await postOpen(harness, otherThread.id, {
        file: null,
        terminalAction: { action: "focus", terminalId: terminal.id },
      });
      const unknown = await postOpen(harness, thread.id, {
        file: null,
        terminalAction: { action: "focus", terminalId: "term_missing" },
      });
      const invalidUrl = await postOpen(harness, thread.id, {
        file: null,
        terminalAction: {
          action: "openBrowser",
          terminalId: terminal.id,
          url: "javascript:alert(1)",
        },
      });
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(invalidUrl.status).toBe(400);
      expect(foreignMove.status).toBe(404);
      expect(socket.messages).toHaveLength(4);
    });
  });

  it("rejects terminal actions for archived threads without broadcasting", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-thread-terminal-archived",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-terminal-archived-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const terminal = createTerminalSession(harness.db, {
        cols: 80,
        daemonSessionId: session.id,
        environmentId: null,
        hostId: host.id,
        initialCwd: "/tmp",
        rows: 24,
        status: "running",
        threadId: thread.id,
        title: "Archived thread terminal",
      });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, thread.id))
        .run();

      const response = await postOpen(harness, thread.id, {
        file: null,
        terminalAction: { action: "focus", terminalId: terminal.id },
      });

      expect(response.status).toBe(404);
      expect(socket.messages).toHaveLength(0);
    });
  });

  it("broadcasts pane actions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-pane-action",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-pane-action-source",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const response = await postPaneAction(harness, thread.id, {
        action: "spotlight",
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ delivered: 1 });
      expect(JSON.parse(socket.messages[0]!)).toEqual({
        type: "thread-pane-action",
        projectId: project.id,
        threadId: thread.id,
        action: "spotlight",
      });
    });
  });
});
