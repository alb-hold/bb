import {
  createProject,
  createThread,
  noopNotifier,
  threads,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("thread list archived CLI request compatibility", () => {
  it("includes archived children with --all and archived ids without a filter", async () => {
    const db = createMigratedConnection();
    const host = upsertHost(db, noopNotifier, { name: "list-test-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "thread-list-archived-test",
      source: {
        hostId: host.id,
        path: "/tmp/thread-list-archived-test",
        type: "local_path",
      },
    });
    const parent = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const activeChild = createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
    });
    const archivedChild = createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
    });
    const unrelatedArchivedThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    db.update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, archivedChild.id))
      .run();
    db.update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, unrelatedArchivedThread.id))
      .run();
    const harness = await createTestAppHarness({ db });
    try {
      const allChildrenResponse = await harness.app.request(
        `/api/v1/threads?parentThreadId=${parent.id}`,
      );
      expect(allChildrenResponse.status).toBe(200);
      const allChildren = (await allChildrenResponse.json()) as Array<{
        id: string;
      }>;
      expect(allChildren.map((thread) => thread.id).sort()).toEqual(
        [activeChild.id, archivedChild.id].sort(),
      );

      const activeChildrenResponse = await harness.app.request(
        `/api/v1/threads?parentThreadId=${parent.id}&archived=false`,
      );
      expect(activeChildrenResponse.status).toBe(200);
      const activeChildren = (await activeChildrenResponse.json()) as Array<{
        id: string;
      }>;
      expect(activeChildren.map((thread) => thread.id)).toEqual([
        activeChild.id,
      ]);

      const archivedIdResponse = await harness.app.request(
        `/api/v1/threads?threadIds=${archivedChild.id}`,
      );
      expect(archivedIdResponse.status).toBe(200);
      const archivedById = (await archivedIdResponse.json()) as Array<{
        id: string;
      }>;
      expect(archivedById.map((thread) => thread.id)).toEqual([
        archivedChild.id,
      ]);
    } finally {
      await harness.cleanup();
      db.$client.close();
    }
  });
});
