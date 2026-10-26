import {
  appendStoredThreadEvent,
  archiveThread,
  createQueuedThreadMessage,
  insertEvents,
  listActiveVisiblePinnedThreadRootsWithPendingInteractionState,
  listThreadsWithPendingInteractionState,
  listThreadsWithPendingInteractionStateForProjects,
  pinThread,
  putThreadRowState,
  searchThreadsWithPendingInteractionState,
  type ThreadSearchResultGroup,
} from "@bb/db";
import type {
  ProjectWithThreadsResponse,
  ThreadListResponse,
  ThreadSearchResponse,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { LOCAL_AGENT_TASK_TYPE, threadScope, turnScope } from "@bb/domain";
import { readJson } from "../../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { toThreadListEntryResponsesForTest } from "../../helpers/thread-list-enrichment.js";

const SEARCH_QUERY = "routeenrichmentprobe";

async function seedThreadListFixture(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, {
    name: "Thread list enrichment route host",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "Thread list enrichment route project",
    path: `/tmp/thread-list-enrichment-${host.id}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/thread-list-enrichment-environment-${host.id}`,
  });
  const definitions = [
    { archived: false, hidden: false, label: "visible-1" },
    { archived: false, hidden: false, label: "visible-2" },
    { archived: false, hidden: false, label: "visible-3" },
    { archived: false, hidden: false, label: "visible-4" },
    { archived: false, hidden: true, label: "hidden" },
    { archived: true, hidden: false, label: "archived-1" },
    { archived: true, hidden: false, label: "archived-2" },
  ];
  let hiddenThreadId: string | undefined;

  for (const [index, definition] of definitions.entries()) {
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      title: `${SEARCH_QUERY} ${definition.label}`,
      visibility: definition.hidden ? "hidden" : "visible",
    });
    if (definition.hidden) hiddenThreadId = thread.id;
    appendStoredThreadEvent(harness.db, harness.hub, {
      threadId: thread.id,
      scope: threadScope(),
      type: "thread/goal/updated",
      data: {
        providerThreadId: `provider-${definition.label}`,
        objective: `Finish ${definition.label}`,
        status: "active",
        tokenBudget: null,
        tokensUsed: index + 1,
        timeUsedSeconds: index + 1,
      },
    });
    appendStoredThreadEvent(harness.db, harness.hub, {
      threadId: thread.id,
      scope: threadScope(),
      type: "thread/extensionState/updated",
      data: {
        providerThreadId: `provider-${definition.label}`,
        kind: "provider-codex/goal",
        payload: {
          objective: `Finish ${definition.label}`,
          status: "active",
          tokenBudget: null,
          tokensUsed: index + 1,
          timeUsedSeconds: index + 1,
        },
      },
    });
    insertEvents(harness.db, harness.hub, [
      {
        threadId: thread.id,
        sequence: 3,
        scope: turnScope(`turn-${definition.label}`),
        type: "item/started",
        itemId: `task-${definition.label}`,
        itemKind: "backgroundTask",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            id: `task-${definition.label}`,
            type: "backgroundTask",
            taskType: LOCAL_AGENT_TASK_TYPE,
            description: `Task for ${definition.label}`,
            status: "pending",
            taskStatus: "running",
            foreground: false,
            skipTranscript: false,
          },
        }),
      },
    ]);
    createQueuedThreadMessage(harness.db, harness.hub, {
      threadId: thread.id,
      content: [
        { type: "text", text: `Queued ${definition.label}`, mentions: [] },
      ],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    putThreadRowState(harness.db, thread.id, {
      statuses: { review: { value: definition.label } },
      progress: null,
    });
    if (definition.archived) {
      archiveThread(harness.db, harness.hub, thread.id);
    }
    if (!definition.archived && !definition.hidden) {
      pinThread(harness.db, harness.hub, { threadId: thread.id });
    }
  }

  return { project, hiddenThreadId };
}

function legacySearchGroup(
  deps: Parameters<typeof toThreadListEntryResponsesForTest>[0],
  group: ThreadSearchResultGroup,
) {
  const entries = toThreadListEntryResponsesForTest(deps, {
    threads: group.results.map((result) => result.thread),
  });
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    total: group.total,
    results: group.results.map((result) => ({
      thread: entriesById.get(result.thread.id)!,
      matches: result.matches,
    })),
  };
}

describe("thread list enrichment route callers", () => {
  it("keeps GET /threads byte-identical for default and paginated project filters", async () => {
    await withTestHarness(async (harness) => {
      const { project, hiddenThreadId } = await seedThreadListFixture(harness);
      const cases = [
        {
          path: "/api/v1/threads?archived=false",
          options: { archived: false, includeHidden: false },
        },
        {
          path: `/api/v1/threads?archived=false&includeHidden=true&projectId=${project.id}&limit=20&offset=0`,
          options: {
            archived: false,
            includeHidden: true,
            projectId: project.id,
            limit: 20,
            offset: 0,
          },
        },
      ];

      for (const testCase of cases) {
        const response = await harness.app.request(testCase.path);
        expect(response.status).toBe(200);
        const actual = (await readJson(response)) as ThreadListResponse;
        const listedThreads = listThreadsWithPendingInteractionState(
          harness.db,
          testCase.options,
        );
        const expected = toThreadListEntryResponsesForTest(harness.deps, {
          threads: listedThreads,
        });
        if (testCase.options.includeHidden) {
          expect(actual.some((entry) => entry.id === hiddenThreadId)).toBe(
            true,
          );
        }
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      }
    });
  });

  it("keeps thread search active and archived groups byte-identical", async () => {
    await withTestHarness(async (harness) => {
      await seedThreadListFixture(harness);
      const response = await harness.app.request(
        `/api/v1/threads/search?query=${SEARCH_QUERY}&limitPerGroup=20`,
      );
      expect(response.status).toBe(200);
      const actual = (await readJson(response)) as ThreadSearchResponse;
      const searched = searchThreadsWithPendingInteractionState(harness.db, {
        query: SEARCH_QUERY,
        limitPerGroup: 20,
      });
      const expected = {
        active: legacySearchGroup(harness.deps, searched.active),
        archived: legacySearchGroup(harness.deps, searched.archived),
      };
      expect(actual.active.total).toBeGreaterThan(1);
      expect(actual.archived.total).toBeGreaterThan(1);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  });

  it("keeps project thread responses byte-identical", async () => {
    await withTestHarness(async (harness) => {
      const { project } = await seedThreadListFixture(harness);
      const response = await harness.app.request(
        "/api/v1/projects?include=threads",
      );
      expect(response.status).toBe(200);
      const actual = (await readJson(response)) as ProjectWithThreadsResponse[];
      const listedThreads = listThreadsWithPendingInteractionStateForProjects(
        harness.db,
        { archived: false, projectIds: [project.id] },
      );
      const expectedThreads = toThreadListEntryResponsesForTest(harness.deps, {
        threads: listedThreads,
      });
      const expected = actual.map((item) => ({
        ...item,
        threads: item.id === project.id ? expectedThreads : [],
      }));
      expect(actual.some((item) => item.id === project.id)).toBe(true);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  });

  it("keeps pinned-root action responses byte-identical", async () => {
    await withTestHarness(async (harness) => {
      await seedThreadListFixture(harness);
      const listedThreads =
        listActiveVisiblePinnedThreadRootsWithPendingInteractionState(
          harness.db,
        );
      expect(listedThreads.length).toBeGreaterThan(1);
      const target = listedThreads[0]!;
      const response = await harness.app.request(
        `/api/v1/threads/${target.id}/pin-order`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previousThreadId: null,
            nextThreadId: listedThreads[1]!.id,
          }),
        },
      );
      expect(response.status).toBe(200);
      const actual = (await readJson(response)) as ThreadListResponse;
      const expected = toThreadListEntryResponsesForTest(harness.deps, {
        threads: listedThreads,
      });
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  });
});
