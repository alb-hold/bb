import { getThreadRowProgressSourceTerminalId } from "@bb/db";
import {
  threadListResponseSchema,
  threadRowStateSchema,
} from "@bb/server-contract";
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
  it("lets an explicit progress clear override terminal ownership", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.6 },
        terminalId: "terminal-a",
      });

      const response = await updateState(harness, thread.id, {
        action: "progress-clear",
        force: true,
      });

      expect(response.status).toBe(200);
      expect(
        threadRowStateSchema.parse(await readJson(response)).progress,
      ).toBeNull();
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ).progress,
      ).toBeNull();
    });
  });

  it("clears progress only when the source terminal matches", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      expect(
        (
          await updateState(harness, thread.id, {
            action: "progress-set",
            progress: { value: 0.6 },
            terminalId: "terminal-a",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await updateState(harness, thread.id, {
            action: "status-set",
            key: "review",
            status: { value: "In progress" },
          })
        ).status,
      ).toBe(200);
      await updateState(harness, thread.id, {
        action: "progress-clear",
        terminalId: "terminal-b",
      });
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ).progress,
      ).toEqual({ value: 0.6 });

      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.4 },
        terminalId: "terminal-b",
      });
      await updateState(harness, thread.id, {
        action: "progress-clear",
        terminalId: "terminal-a",
      });
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ).progress,
      ).toEqual({ value: 0.4 });

      await updateState(harness, thread.id, {
        action: "progress-clear",
        terminalId: "terminal-b",
      });
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ).progress,
      ).toBeNull();
    });
  });

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
      expect(notifyProject).toHaveBeenCalledWith(thread.projectId, [
        "threads-changed",
      ]);

      const setSecondStatus = await updateState(harness, thread.id, {
        action: "status-set",
        key: "planning",
        status: { value: "In progress" },
      });
      expect(setSecondStatus.status).toBe(200);

      const setProgress = await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.75, label: "Review" },
      });
      expect(setProgress.status).toBe(200);
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ),
      ).toEqual({
        statuses: {
          review: { value: "Ready", icon: "✓", priority: 5 },
          planning: { value: "In progress" },
        },
        progress: { value: 0.75, label: "Review" },
      });
      const listResponse = await harness.app.request(
        `/api/v1/threads?projectId=${thread.projectId}`,
      );
      const list = threadListResponseSchema.parse(await readJson(listResponse));
      expect(list.find((entry) => entry.id === thread.id)?.rowState).toEqual({
        statuses: {
          review: { value: "Ready", icon: "✓", priority: 5 },
          planning: { value: "In progress" },
        },
        progress: { value: 0.75, label: "Review" },
      });

      for (let index = 0; index < 6; index += 1) {
        expect(
          (
            await updateState(harness, thread.id, {
              action: "status-set",
              key: `status-${index}`,
              status: { value: "ok" },
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await updateState(harness, thread.id, {
            action: "status-set",
            key: "ninth",
            status: { value: "too many" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await updateState(harness, thread.id, {
            action: "progress-set",
            progress: { value: 1.01 },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await updateState(harness, thread.id, {
            action: "status-set",
            key: "review",
            status: { value: "x".repeat(121) },
          })
        ).status,
      ).toBe(400);

      const clearOne = await updateState(harness, thread.id, {
        action: "status-clear",
        key: "review",
      });
      expect(threadRowStateSchema.parse(await readJson(clearOne))).toEqual({
        statuses: {
          planning: { value: "In progress" },
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `status-${index}`,
              { value: "ok" },
            ]),
          ),
        },
        progress: { value: 0.75, label: "Review" },
      });
      expect(notifyThread).toHaveBeenLastCalledWith(thread.id, [
        "status-changed",
      ]);
      expect(notifyProject).toHaveBeenLastCalledWith(thread.projectId, [
        "threads-changed",
      ]);

      const clearProgress = await updateState(harness, thread.id, {
        action: "progress-clear",
      });
      expect(threadRowStateSchema.parse(await readJson(clearProgress))).toEqual(
        {
          statuses: {
            planning: { value: "In progress" },
            ...Object.fromEntries(
              Array.from({ length: 6 }, (_, index) => [
                `status-${index}`,
                { value: "ok" },
              ]),
            ),
          },
          progress: null,
        },
      );
      expect(notifyThread).toHaveBeenLastCalledWith(thread.id, [
        "status-changed",
      ]);
      expect(notifyProject).toHaveBeenLastCalledWith(thread.projectId, [
        "threads-changed",
      ]);

      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.85 },
        terminalId: "terminal-owner",
      });
      expect(getThreadRowProgressSourceTerminalId(harness.db, thread.id)).toBe(
        "terminal-owner",
      );

      const cleared = await updateState(harness, thread.id, {
        action: "clear",
      });
      expect(threadRowStateSchema.parse(await readJson(cleared))).toEqual({
        statuses: {},
        progress: null,
      });
      expect(
        getThreadRowProgressSourceTerminalId(harness.db, thread.id),
      ).toBeNull();
      expect(notifyThread).toHaveBeenLastCalledWith(thread.id, [
        "status-changed",
      ]);
      expect(notifyProject).toHaveBeenLastCalledWith(thread.projectId, [
        "threads-changed",
      ]);
    });
  });

  it("keeps a legacy clear from erasing terminal-owned progress", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.6 },
        terminalId: "terminal-a",
      });
      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.4 },
        terminalId: "terminal-b",
      });

      const legacyClear = await updateState(harness, thread.id, {
        action: "progress-clear",
      });
      expect(legacyClear.status).toBe(200);
      expect(
        threadRowStateSchema.parse(await readJson(legacyClear)).progress,
      ).toEqual({ value: 0.4 });
      expect(
        threadRowStateSchema.parse(
          await readJson(await readState(harness, thread.id)),
        ).progress,
      ).toEqual({ value: 0.4 });

      await updateState(harness, thread.id, {
        action: "progress-set",
        progress: { value: 0.2 },
      });
      const ownerlessClear = await updateState(harness, thread.id, {
        action: "progress-clear",
      });
      expect(
        threadRowStateSchema.parse(await readJson(ownerlessClear)).progress,
      ).toBeNull();
    });
  });
});
