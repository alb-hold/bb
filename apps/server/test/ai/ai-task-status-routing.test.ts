import { afterEach, describe, expect, it, vi } from "vitest";
import { runTextAiTask } from "../../src/services/ai/ai-tasks.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { withTestHarness } from "../helpers/test-app.js";

const PROMPT = "Write a title for: fix the flaky login test";
afterEach(() => vi.useRealTimers());

describe("existing AI task routing around a slow status check", () => {
  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service whose status check outlasts 2 s, and keeps routing past it on a repeated call after the late Ready",
    async (task) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        let firstSettled = false;
        const firstPromise = runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        }).then((result) => {
          firstSettled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(firstSettled).toBe(false);
        expect(codex.completeCalls).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(firstSettled).toBe(true);
        const first = await firstPromise;
        expect(first).toMatchObject({ ok: true, value: "Codex title" });

        await vi.advanceTimersByTimeAsync(500);
        expect(cloud.completeCalls).toEqual([]);
        let againSettled = false;
        const againPromise = runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        }).then((result) => {
          againSettled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(againSettled).toBe(true);
        const again = await againPromise;
        expect(again).toMatchObject({ ok: true, value: "Codex title" });
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(2);
      });
    },
  );

  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service whose status check, started by Settings, outlasted 2 s before the task arrived",
    async (task) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        const settings = harness.deps.aiServices.status({
          pluginId: "bb-ai",
          serviceId: "bb",
        });
        await vi.advanceTimersByTimeAsync(2_200);
        let resultSettled = false;
        const resultPromise = runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        }).then((result) => {
          resultSettled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(resultSettled).toBe(true);
        const result = await resultPromise;
        expect(result).toMatchObject({ ok: true, value: "Codex title" });

        await vi.advanceTimersByTimeAsync(300);
        await settings;
        await vi.advanceTimersByTimeAsync(600);
        const afterLateReady = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        expect(afterLateReady).toMatchObject({
          ok: true,
          value: "Codex title",
        });
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(2);
      });
    },
  );

  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service when it joins a status check that Settings started 1.5 s earlier, at that check's own 2 s",
    async (task) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        void harness.deps.aiServices.status({
          pluginId: "bb-ai",
          serviceId: "bb",
        });
        await vi.advanceTimersByTimeAsync(1_500);
        let resultSettled = false;
        const resultPromise = runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        }).then((result) => {
          resultSettled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(resultSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(resultSettled).toBe(true);
        const result = await resultPromise;
        expect(result).toMatchObject({ ok: true, value: "Codex title" });
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(1);
      });
    },
  );
});
