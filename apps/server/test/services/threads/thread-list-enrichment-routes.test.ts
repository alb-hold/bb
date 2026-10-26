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
  SYSTEM_RELEASE_ACTOR,
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

function recordEnrichmentBinds(harness: TestAppHarness) {
  const bindings: { count: number; source: string }[] = [];
  const originalPrepare = harness.db.$client.prepare.bind(harness.db.$client);
  harness.db.$client.prepare = ((source: string) => {
    const statement = originalPrepare(source);
    if (
      /events_thread_state_thread_sequence_idx|events_background_task_thread_type_item_sequence_idx|interrupted\.sequence|queued_thread_messages|fork_thread_row_states/i.test(
        source,
      )
    ) {
      const methods = statement as unknown as Record<
        "all" | "get" | "run" | "iterate",
        (...params: unknown[]) => unknown
      >;
      for (const method of ["all", "get", "run", "iterate"] as const) {
        const original = methods[method].bind(statement);
        methods[method] = (...params: unknown[]) => {
          bindings.push({ count: params.length, source });
          return original(...params);
        };
      }
    }
    return statement;
  }) as typeof harness.db.$client.prepare;
  return {
    count: () => bindings.reduce((sum, binding) => sum + binding.count, 0),
    clear: () => bindings.splice(0),
  };
}

async function seedBindCountFixture(
  harness: TestAppHarness,
  projectCount: number,
  threadCount: number,
) {
  const { host } = seedHostSession(harness.deps, {
    name: "Thread list enrichment bind host",
  });
  const projects = Array.from(
    { length: projectCount },
    (_, index) =>
      seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: `Thread list enrichment bind project ${index}`,
        path: `/tmp/thread-list-enrichment-bind-${host.id}-${index}`,
      }).project,
  );
  const threadIds = Array.from(
    { length: threadCount },
    (_, index) =>
      seedThread(harness.deps, {
        projectId: projects[index % projects.length]!.id,
        status: index % 2 === 0 ? "active" : "idle",
        title: `Thread list enrichment bind thread ${index}`,
      }).id,
  );
  return { projects, threadIds };
}

async function seedThreadListFixture(
  harness: TestAppHarness,
  projectCount = 1,
) {
  const { host } = seedHostSession(harness.deps, {
    name: "Thread list enrichment route host",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "Thread list enrichment route project",
    path: `/tmp/thread-list-enrichment-${host.id}`,
  });
  const projects = [project];
  for (let index = 1; index < projectCount; index += 1) {
    projects.push(
      seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: `Thread list enrichment route project ${index}`,
        path: `/tmp/thread-list-enrichment-${host.id}-${index}`,
      }).project,
    );
  }
  const environments = projects.map((listedProject, index) =>
    seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: listedProject.id,
      path: `/tmp/thread-list-enrichment-environment-${host.id}-${index}`,
    }),
  );
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
      projectId: projects[index % projects.length]!.id,
      environmentId: environments[index % environments.length]!.id,
      status: definition.label === "visible-1" ? "active" : "idle",
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
      archiveThread(harness.db, harness.hub, thread.id, SYSTEM_RELEASE_ACTOR);
    }
    if (!definition.archived && !definition.hidden) {
      pinThread(harness.db, harness.hub, { threadId: thread.id });
    }
  }

  return { project, projects, hiddenThreadId };
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
      const { projects } = await seedThreadListFixture(harness, 3);
      const response = await harness.app.request(
        "/api/v1/projects?include=threads",
      );
      expect(response.status).toBe(200);
      const actual = (await readJson(response)) as ProjectWithThreadsResponse[];
      const expectedByProjectId = new Map<
        string,
        ReturnType<typeof toThreadListEntryResponsesForTest>
      >();
      for (const listedProject of projects) {
        const projectThreads =
          listThreadsWithPendingInteractionStateForProjects(harness.db, {
            archived: false,
            projectIds: [listedProject.id],
          });
        expectedByProjectId.set(
          listedProject.id,
          toThreadListEntryResponsesForTest(harness.deps, {
            threads: projectThreads,
          }),
        );
      }
      const expected = actual.map((item) => ({
        ...item,
        threads: expectedByProjectId.get(item.id) ?? [],
      }));
      expect(
        projects.every((listedProject) =>
          actual.some((item) => item.id === listedProject.id),
        ),
      ).toBe(true);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  });

  it("keeps project-route enrichment binds constant across project and thread counts", async () => {
    const counts: number[] = [];
    for (const projectCount of [1, 10, 200]) {
      for (const threadCount of [10, 300]) {
        await withTestHarness(async (harness) => {
          await seedBindCountFixture(harness, projectCount, threadCount);
          const recorder = recordEnrichmentBinds(harness);
          const response = await harness.app.request(
            "/api/v1/projects?include=threads",
          );
          expect(response.status).toBe(200);
          const actual = (await readJson(
            response,
          )) as ProjectWithThreadsResponse[];
          const routeBindCount = recorder.count();
          recorder.clear();
          const listedProjectIds = actual.map((project) => project.id);
          const listedThreads =
            listThreadsWithPendingInteractionStateForProjects(harness.db, {
              archived: false,
              projectIds: listedProjectIds,
            });
          const expectedThreads = toThreadListEntryResponsesForTest(
            harness.deps,
            {
              threads: listedThreads,
            },
          );
          const threadsByProjectId = new Map<string, typeof expectedThreads>();
          for (const project of expectedThreads) {
            const projectThreads =
              threadsByProjectId.get(project.projectId) ?? [];
            projectThreads.push(project);
            threadsByProjectId.set(project.projectId, projectThreads);
          }
          const expected = actual.map((project) => ({
            ...project,
            threads: threadsByProjectId.get(project.id) ?? [],
          }));
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
          counts.push(routeBindCount);
        });
      }
    }
    expect(counts).toHaveLength(6);
    expect(new Set(counts).size).toBe(1);
  });

  it("keeps threadIds-route enrichment binds constant across ID and thread counts", async () => {
    const allCounts: number[] = [];
    for (const threadCount of [10, 300]) {
      await withTestHarness(async (harness) => {
        const { threadIds } = await seedBindCountFixture(
          harness,
          1,
          threadCount,
        );
        const recorder = recordEnrichmentBinds(harness);
        const counts: number[] = [];
        for (const requestedCount of [1, 10, 200]) {
          const requestedIds = Array.from(
            { length: requestedCount },
            (_, index) => threadIds[index] ?? `missing-thread-${index}`,
          );
          const response = await harness.app.request(
            `/api/v1/threads?threadIds=${requestedIds.join(",")}`,
          );
          expect(response.status).toBe(200);
          const actual = (await readJson(response)) as ThreadListResponse[];
          const routeBindCount = recorder.count();
          recorder.clear();
          const listedThreads = listThreadsWithPendingInteractionState(
            harness.db,
            { threadIds: requestedIds },
          );
          const expected = toThreadListEntryResponsesForTest(harness.deps, {
            threads: listedThreads,
          });
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
          recorder.clear();
          counts.push(routeBindCount);
          allCounts.push(routeBindCount);
        }
        expect(counts).toHaveLength(3);
        expect(new Set(counts).size, JSON.stringify(counts)).toBe(1);
      });
    }
    expect(allCounts).toHaveLength(6);
    expect(new Set(allCounts).size, JSON.stringify(allCounts)).toBe(1);
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
