import { archiveThread, createNativeTerminalThread } from "@bb/db";
import { threadCountResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function count(harness: TestAppHarness, query: string) {
  const response = await harness.app.request(`/api/v1/threads/count${query}`);
  expect(response.status).toBe(200);
  return threadCountResponseSchema.parse(await readJson(response));
}

describe("GET /threads/count", () => {
  it("counts and groups without listing, excluding archived threads by default", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-count",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-count-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-count-source",
      });
      const root = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: root.id,
        projectId: project.id,
        status: "active",
      });
      const archived = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.deps.hub, archived.id);

      expect(await count(harness, "")).toEqual({ total: 2 });
      expect(await count(harness, "?includeArchived=true")).toEqual({
        total: 3,
      });
      expect(await count(harness, "?status=active")).toEqual({ total: 2 });
      // `none` is the unambiguous "root threads only" value; a thread id can
      // never collide with it.
      expect(await count(harness, "?parentThreadId=none")).toEqual({
        total: 1,
      });
      expect(await count(harness, `?parentThreadId=${root.id}`)).toEqual({
        total: 1,
      });
      expect(await count(harness, `?hostId=${host.id}`)).toEqual({ total: 2 });

      const grouped = await count(harness, "?groupBy=host");
      expect(grouped.total).toBe(2);
      expect(grouped.groups).toEqual([{ key: host.id, count: 2 }]);
      // An ungrouped count has no group list at all, rather than one anonymous
      // group.
      expect((await count(harness, "")).groups).toBeUndefined();
    });
  });
});

it.each(["count", "summary"])(
  "%s treats a clean native child as idle and a genuine failure as failed",
  async (surface) => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-native-count",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/native-count",
      });
      const parent = seedThread(harness.deps, {
        projectId: project.id,
        status: "idle",
      });
      const clean = seedThread(harness.deps, {
        projectId: project.id,
        parentThreadId: parent.id,
        status: "error",
      });
      const failed = seedThread(harness.deps, {
        projectId: project.id,
        parentThreadId: parent.id,
        status: "error",
      });
      createNativeTerminalThread(harness.db, {
        threadId: clean.id,
        providerId: clean.providerId,
        nativeSessionId: "clean-session",
        initialPrompt: null,
        initialImages: [],
        model: null,
      });
      harness.db.$client
        .prepare(
          "UPDATE fork_native_terminal_threads SET terminal_session_id = 'terminal-clean', lost_idle_terminal_session_id = 'terminal-clean' WHERE thread_id = ?",
        )
        .run(clean.id);
      if (surface === "count") {
        expect(
          await count(harness, `?status=error&parentThreadId=${parent.id}`),
        ).toEqual({ total: 1 });
        expect(
          await count(
            harness,
            `?status=idle&parentThreadId=${parent.id}&groupBy=project`,
          ),
        ).toEqual({ total: 1, groups: [{ key: project.id, count: 1 }] });
      } else {
        const response = await harness.app.request(
          `/api/v1/threads/${parent.id}/child-summary`,
        );
        const summary = await readJson(response);
        expect(summary).toMatchObject({ failed: 1, idle: 1 });
        expect(summary).toMatchObject({
          children: expect.arrayContaining([
            { id: clean.id, status: "idle", title: clean.title },
            { id: failed.id, status: "error", title: failed.title },
          ]),
        });
      }
    });
  },
);
