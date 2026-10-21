import { describe, expect, it } from "vitest";
import {
  getThread,
  getThreadExecutionOverride,
  listEvents,
  listQueuedThreadMessages,
  setThreadExecutionOverride,
} from "@bb/db";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";

function stubProviderCatalog(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
  providerId: string,
  model: string,
): void {
  registerProviderHostRpcResponder(harness, {
    hostId,
    sessionId,
    modelsByProviderId: {
      [providerId]: {
        models: [
          {
            id: model,
            model,
            displayName: model,
            description: "",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "xhigh", description: "" },
              { reasoningEffort: "max", description: "" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        selectedOnlyModels: [],
      },
    },
  });
}

function seedProviderThread(
  harness: TestAppHarness,
  providerId = "claude-code",
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-override-${providerId}`,
  });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
  });
  return { host, session, thread };
}

function patchThread(harness: TestAppHarness, threadId: string, body: unknown) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /threads/:id execution override", () => {
  for (const provider of [
    { id: "codex", model: "gpt-5.6-sol" },
    { id: "claude-code", model: "claude-opus-4-8" },
    { id: "pi", model: "openai/gpt-5.4" },
    { id: "acp-cursor", model: "gpt-5.3-codex" },
  ]) {
    it(`persists a catalog-scoped model + reasoning override for ${provider.id}`, async () => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedProviderThread(
          harness,
          provider.id,
        );
        stubProviderCatalog(
          harness,
          host.id,
          session.id,
          provider.id,
          provider.model,
        );

        const response = await patchThread(harness, thread.id, {
          model: provider.model,
          reasoningLevel: "high",
        });

        expect(response.status).toBe(200);
        expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
          modelOverride: provider.model,
          reasoningLevelOverride: "high",
        });
      });
    });
  }

  it("rejects a model that is not in the provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-4-8",
      );

      const response = await patchThread(harness, thread.id, {
        model: "gpt-5",
      });

      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(JSON.stringify(body)).toContain(
        "not available in this thread's claude-code model catalog",
      );
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });

  it("refuses a sticky model override that conflicts with child policy before writing", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-5-5",
      );

      const response = await patchThread(harness, thread.id, {
        parentThreadId: parent.id,
        model: "claude-opus-5-5",
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });

  it("refuses reparenting when the existing sticky model conflicts", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: "high",
      });

      const response = await patchThread(harness, thread.id, {
        parentThreadId: parent.id,
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBeNull();
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: "high",
      });
    });
  });

  it("rejects a conflicting queued-message model before inserting a queue row", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      const child = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        parentThreadId: parent.id,
        status: "active",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${child.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "queue this" }],
            model: "claude-opus-5-5",
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(listQueuedThreadMessages(harness.db, child.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", child.id),
      ).toEqual([]);
    });
  });

  it("rejects a conflicting edit before stopping the child thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      const child = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        parentThreadId: parent.id,
        status: "idle",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${child.id}/edit-message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationId: "conflicting-child-edit",
            input: [{ type: "text", text: "edited message" }],
            model: "claude-opus-5-5",
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(getThread(harness.db, child.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "thread.stop", child.id),
      ).toEqual([]);
    });
  });

  it("allows reparenting while clearing a conflicting stored model in one PATCH", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-5-5",
      );
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });

      const response = await patchThread(harness, thread.id, {
        parentThreadId: parent.id,
        model: null,
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(parent.id);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });

  it.each([
    {
      name: "invalid section",
      patch: { sectionId: "sec_missing" },
      expectedStatus: 404,
    },
    {
      name: "invalid session options",
      patch: { sessionOptions: { missing_option: "value" } },
      expectedStatus: 400,
    },
  ])(
    "does not partially apply a model and parent PATCH with $name",
    async ({ patch, expectedStatus }) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedProviderThread(harness);
        const originalTitle = getThread(harness.db, thread.id)?.title;
        const parent = seedThread(harness.deps, {
          projectId: thread.projectId,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        });
        stubProviderCatalog(
          harness,
          host.id,
          session.id,
          "claude-code",
          "claude-opus-5-5",
        );
        const eventsBefore = listEvents(harness.db, { threadId: thread.id });

        const response = await patchThread(harness, thread.id, {
          parentThreadId: parent.id,
          model: "claude-opus-5-5",
          reasoningLevel: "high",
          title: "must not persist",
          ...patch,
        });

        expect(response.status).toBe(expectedStatus);
        expect(getThread(harness.db, thread.id)).toMatchObject({
          parentThreadId: null,
          sectionId: null,
          title: originalTitle,
        });
        expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
          modelOverride: null,
          reasoningLevelOverride: null,
        });
        expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
          eventsBefore,
        );
      });
    },
  );

  it("allows unrelated metadata updates on a legacy child with a conflicting stored override", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const parent = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        parentThreadId: parent.id,
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });

      const response = await patchThread(harness, thread.id, {
        title: "Legacy override retained",
      });

      expect(response.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });

      const profileResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/execution-profile`,
      );
      expect(profileResponse.status).toBe(200);
      expect(await readJson(profileResponse)).toMatchObject({
        overrides: { model: "claude-opus-5-5" },
        nextTurn: { model: "claude-sonnet-5-5" },
      });
    });
  });
});
