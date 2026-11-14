import { THREAD_PURGE_BATCH_SIZE, getThread } from "@bb/db";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";

describe("thread deletion on a removed machine", () => {
  it("finishes deleting the thread without asking the removed machine to delete storage", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const host = seedHost(harness.deps, { id: "host_removed" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });

      const removed = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);

      const deleted = await harness.app.request(`${API}/threads/${thread.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadsConfirmed: false }),
      });
      expect(deleted.status).toBe(200);
      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(
        listQueuedThreadCommands(harness, "thread.storage.delete", thread.id),
      ).toHaveLength(0);
    });
  });
});

describe("deleting a thread with a large event history", () => {
  it("drains the history in batches and removes the thread across sweeps", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: primary.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "idle",
      });
      const eventCount = THREAD_PURGE_BATCH_SIZE * 2 + 5;
      harness.db.transaction((tx) => {
        for (let i = 0; i < eventCount; i += 1) {
          tx.run(
            sql`INSERT INTO events (id, thread_id, scope_kind, sequence, type, data, created_at) VALUES (${`${thread.id}_e${i}`}, ${thread.id}, 'thread', ${i + 1000}, 'thread/started', '{}', ${i})`,
          );
        }
      });

      const deleted = await harness.app.request(`${API}/threads/${thread.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadsConfirmed: false }),
      });
      expect(deleted.status).toBe(200);
      for (let sweep = 0; sweep < 3; sweep += 1) {
        await runThreadLifecycleSweep(harness.deps);
      }

      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(
        harness.db.get<{ count: number }>(
          sql`SELECT count(*) AS count FROM events WHERE thread_id = ${thread.id}`,
        )?.count,
      ).toBe(0);
    });
  });
});
