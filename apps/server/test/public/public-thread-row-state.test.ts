import { threadListResponseSchema, threadRowStateSchema } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function readState(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/row-state`);
}

async function updateState(
  harness: TestAppHarness,
  threadId: string,
  body: unknown,
) {
  return harness.app.request(`/api/v1/threads/${threadId}/row-state`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

describe("public thread row state", () => {
  it("persists changes, notifies sidebar subscribers, validates bounds, and clears", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const notifyThread = vi.spyOn(harness.hub, "notifyThread");
      const notifyProject = vi.spyOn(harness.hub, "notifyProject");
      const initial = await readState(harness, thread.id);
      expect(threadRowStateSchema.parse(await readJson(initial))).toEqual({
        statuses: {},
        progress: null,
      });

      const setStatus = await updateState(harness, thread.id, {
        action: "status-set",
        key: "review",
        status: { value: "Ready", icon: "✓", priority: 5 },
      });
      expect(setStatus.status).toBe(200);
      expect(notifyThread).toHaveBeenCalledWith(thread.id, ["status-changed"]);
      expect(notifyProject).toHaveBeenCalledWith(thread.projectId, ["threads-changed"]);

      const setProgress = await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.75, label: "Review" },
      });
      expect(setProgress.status).toBe(200);
      expect(threadRowStateSchema.parse(await readJson(await readState(harness, thread.id)))).toEqual({
        statuses: { review: { value: "Ready", icon: "✓", priority: 5 } },
        progress: { value: 0.75, label: "Review" },
      });
      const listResponse = await harness.app.request(
        `/api/v1/threads?projectId=${thread.projectId}`,
      );
      const list = threadListResponseSchema.parse(await readJson(listResponse));
      expect(list.find((entry) => entry.id === thread.id)?.rowState).toEqual({
        statuses: { review: { value: "Ready", icon: "✓", priority: 5 } },
        progress: { value: 0.75, label: "Review" },
      });

      for (let index = 0; index < 7; index += 1) {
        expect((await updateState(harness, thread.id, {
          action: "status-set",
          key: `status-${index}`,
          status: { value: "ok" },
        })).status).toBe(200);
      }
      expect((await updateState(harness, thread.id, {
        action: "status-set",
        key: "ninth",
        status: { value: "too many" },
      })).status).toBe(400);
      expect((await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 1.01 },
      })).status).toBe(400);
      expect((await updateState(harness, thread.id, {
        action: "status-set",
        key: "review",
        status: { value: "x".repeat(121) },
      })).status).toBe(400);

      const cleared = await updateState(harness, thread.id, { action: "clear" });
      expect(threadRowStateSchema.parse(await readJson(cleared))).toEqual({
        statuses: {},
        progress: null,
      });
    });
  });
});
