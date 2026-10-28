// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  createEnvironment,
  createProject,
  createTerminalSession,
  createThread,
  upsertHost,
} from "../../../../../packages/db/src/index.js";
import { createMigratedConnection } from "../../../../../packages/db/src/testing.js";
import { noopNotifier } from "../../../../../packages/db/src/notifier.js";
import { Hono } from "../../../../server/node_modules/hono";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import type { AppDeps } from "../../../../server/src/types.js";
import { registerTerminalRoutes } from "../../../../server/src/routes/terminals.js";
import { registerThreadRowStateRoutes } from "../../../../server/src/routes/threads/row-state.js";
import { usePanelTerminals } from "./usePanelTerminals";
import {
  useThreadTerminalController,
  type ThreadTerminalControllerArgs,
} from "../thread/terminal/useThreadTerminalController";

let database: ReturnType<typeof createMigratedConnection>;
let server: Hono;
let hub: AppDeps["hub"];
let closedTerminalIds: Set<string>;
let terminalThreadById: Map<string, string>;
let requests: Array<{ body: unknown; method: string; pathname: string }>;
let completedProgressWrites: number[];
let holdNextProgressSet: (() => Promise<void>) | null;

function terminal(
  id: string,
  threadId: string,
  environmentId: string,
  hostId: string,
): TerminalSession {
  return makeTerminalSession({
    environmentId,
    hostId,
    id,
    status: "running",
    threadId,
  });
}

async function readProgress(threadId: string) {
  const response = await server.request(
    `/api/v1/threads/${threadId}/row-state`,
  );
  const rowState = (await response.json()) as {
    progress: { value: number } | null;
  };
  return rowState.progress;
}

function controllerArgs(
  threadId: string,
  terminalId: string,
): ThreadTerminalControllerArgs {
  return {
    isPanelOpen: true,
    isPanelPersistedOpen: true,
    preferredTerminalId: terminalId,
    syncThreadId: threadId,
    target: { kind: "thread", threadId },
  };
}

function createThreadWithTerminals() {
  const host = upsertHost(database, noopNotifier, { name: "Host" });
  const { project } = createProject(database, noopNotifier, {
    name: "Project",
    source: {
      hostId: host.id,
      path: "/tmp/split-progress-project",
      type: "local_path",
    },
  });
  const environment = createEnvironment(database, noopNotifier, {
    hostId: host.id,
    path: "/tmp/split-progress-environment",
    projectId: project.id,
    providerOwnsPath: false,
    status: "ready",
  });
  const thread = createThread(database, noopNotifier, {
    environmentId: environment.id,
    parentNotifications: "auto",
    projectId: project.id,
    providerId: "codex",
    status: "idle",
    title: "Thread",
    titleFallback: "Thread",
    visibility: "visible",
  });
  const sessionA = createTerminalSession(database, {
    cols: 100,
    daemonSessionId: null,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: "/tmp/work-a",
    rows: 30,
    status: "running",
    threadId: thread.id,
    title: "Shell A",
  });
  const sessionB = createTerminalSession(database, {
    cols: 100,
    daemonSessionId: null,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: "/tmp/work-b",
    rows: 30,
    status: "running",
    threadId: thread.id,
    title: "Shell B",
  });
  terminalThreadById.set(sessionA.id, thread.id);
  terminalThreadById.set(sessionB.id, thread.id);
  return { environment, host, project, sessionA, sessionB, thread };
}

beforeEach(async () => {
  database = createMigratedConnection();
  hub = {
    notifyProject: () => undefined,
    notifyThread: () => undefined,
  } as unknown as AppDeps["hub"];
  closedTerminalIds = new Set();
  terminalThreadById = new Map();
  completedProgressWrites = [];
  holdNextProgressSet = null;
  const terminalSessions = {
    closeTerminal: async ({ terminalId }: { terminalId: string }) => {
      closedTerminalIds.add(terminalId);
      return makeTerminalSession({
        id: terminalId,
        status: "exited",
        threadId: terminalThreadById.get(terminalId) ?? null,
      });
    },
  };
  const deps = { db: database, hub, terminalSessions } as unknown as AppDeps;
  const api = new Hono();
  registerTerminalRoutes(api, deps);
  registerThreadRowStateRoutes(api, deps);
  server = new Hono().route("/api/v1", api);
  requests = [];
  vi.stubGlobal(
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "GET" ? null : await request.clone().json();
      requests.push({
        body,
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
      if (
        request.method === "PATCH" &&
        typeof body === "object" &&
        body !== null &&
        "action" in body &&
        body.action === "progress-set" &&
        holdNextProgressSet !== null
      ) {
        const hold = holdNextProgressSet;
        holdNextProgressSet = null;
        await hold();
      }
      const response = await server.request(request);
      if (
        request.method === "PATCH" &&
        typeof body === "object" &&
        body !== null &&
        "action" in body &&
        body.action === "progress-set" &&
        "progress" in body &&
        typeof body.progress === "object" &&
        body.progress !== null &&
        "value" in body.progress &&
        typeof body.progress.value === "number"
      ) {
        completedProgressWrites.push(body.progress.value);
      }
      return response;
    },
  );
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.$client.close();
});

describe("thread terminal tab close progress integration", () => {
  it("keeps a sibling's progress and clears it when its owner tab closes", async () => {
    const { environment, host, sessionA, sessionB, thread } =
      createThreadWithTerminals();
    vi.spyOn(sdk.terminals, "list").mockResolvedValue({
      sessions: [
        terminal(sessionA.id, thread.id, environment.id, host.id),
        terminal(sessionB.id, thread.id, environment.id, host.id),
      ],
    });

    const { wrapper } = createQueryClientTestHarness();
    const controller = renderHook(
      () => useThreadTerminalController(controllerArgs(thread.id, sessionA.id)),
      { wrapper },
    );
    await waitFor(() =>
      expect(controller.result.current.activeSession?.id).toBe(sessionA.id),
    );
    act(() => controller.result.current.handleActiveTerminalProgressChange(0.6));
    await waitFor(async () =>
      expect(await readProgress(thread.id)).toEqual({ value: 0.6 }),
    );
    controller.unmount();

    const panel = renderHook(
      () =>
        usePanelTerminals({
          acceptsSession: (session) => session.threadId === thread.id,
          createTarget: { kind: "thread", threadId: thread.id },
          isFocused: true,
          panelStateId: thread.id,
          reveal: () => undefined,
          syncThreadId: thread.id,
          tabsCarryTarget: false,
        }),
      { wrapper },
    );

    act(() => panel.result.current.close(sessionB.id));
    await waitFor(() =>
      expect(closedTerminalIds.has(sessionB.id)).toBe(true),
    );
    expect(await readProgress(thread.id)).toEqual({ value: 0.6 });

    act(() => panel.result.current.close(sessionA.id));
    await waitFor(() =>
      expect(closedTerminalIds.has(sessionA.id)).toBe(true),
    );
    await waitFor(async () => expect(await readProgress(thread.id)).toBeNull());
    expect(requests).toContainEqual({
      body: { action: "progress-clear", terminalId: sessionA.id },
      method: "PATCH",
      pathname: `/api/v1/threads/${thread.id}/row-state`,
    });
    const closeRequestIndex = requests.findIndex(
      (request) =>
        request.method === "POST" &&
        request.pathname === `/api/v1/terminals/${sessionA.id}/close`,
    );
    const clearRequestIndex = requests.findIndex(
      (request) =>
        request.method === "PATCH" &&
        request.pathname === `/api/v1/threads/${thread.id}/row-state` &&
        typeof request.body === "object" &&
        request.body !== null &&
        "action" in request.body &&
        request.body.action === "progress-clear" &&
        "terminalId" in request.body &&
        request.body.terminalId === sessionA.id,
    );
    expect(closeRequestIndex).toBeGreaterThanOrEqual(0);
    expect(clearRequestIndex).toBeGreaterThan(closeRequestIndex);
  });

  it("keeps the newer terminal write when older network delivery is delayed", async () => {
    const { environment, host, sessionA, sessionB, thread } =
      createThreadWithTerminals();
    vi.spyOn(sdk.terminals, "list").mockResolvedValue({
      sessions: [
        terminal(sessionA.id, thread.id, environment.id, host.id),
        terminal(sessionB.id, thread.id, environment.id, host.id),
      ],
    });

    let markFirstWriteHeld!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWriteHeld = new Promise<void>((resolve) => {
      markFirstWriteHeld = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    holdNextProgressSet = async () => {
      markFirstWriteHeld();
      await firstWriteGate;
    };

    const { wrapper } = createQueryClientTestHarness();
    const controllerA = renderHook(
      () => useThreadTerminalController(controllerArgs(thread.id, sessionA.id)),
      { wrapper },
    );
    const controllerB = renderHook(
      () => useThreadTerminalController(controllerArgs(thread.id, sessionB.id)),
      { wrapper },
    );
    await waitFor(() =>
      expect(controllerA.result.current.activeSession?.id).toBe(sessionA.id),
    );
    await waitFor(() =>
      expect(controllerB.result.current.activeSession?.id).toBe(sessionB.id),
    );

    try {
      act(() => controllerA.result.current.handleActiveTerminalProgressChange(0.6));
      await firstWriteHeld;
      act(() => controllerB.result.current.handleActiveTerminalProgressChange(0.4));
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      expect(
        requests.filter(
          (request) =>
            request.method === "PATCH" &&
            typeof request.body === "object" &&
            request.body !== null &&
            "action" in request.body &&
            request.body.action === "progress-set",
        ),
      ).toHaveLength(1);
    } finally {
      releaseFirstWrite();
    }

    await waitFor(() => expect(completedProgressWrites).toEqual([0.6, 0.4]));
    expect(await readProgress(thread.id)).toEqual({ value: 0.4 });
  });
});
