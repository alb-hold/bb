import { describe, expect, it } from "vitest";
import { turnRequestEventDataSchema } from "@bb/domain";
import {
  createNativeTerminalThread,
  getThread,
  getThreadExecutionOverride,
  listEvents,
  listQueuedThreadMessages,
  setThreadExecutionOverride,
  updateThread,
} from "@bb/db";
import { seedQueuedMessage } from "../helpers/seed.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  registerProviderHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { availableModelFixture } from "../helpers/available-models.js";
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

function registerSendHostResponder(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
) {
  return registerHostRpcResponder(harness, {
    hostId,
    sessionId,
    handle: ({ command }): HostRpcHandlerResult => {
      switch (command.type) {
        case "host.read_workspace_agent_context":
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        case "provider.list_models":
          return {
            ok: true,
            result: {
              models: [
                availableModelFixture({ model: "claude-opus-5-5" }),
                availableModelFixture({ model: "claude-sonnet-5-5" }),
              ],
              selectedOnlyModels: [],
            },
          };
        case "thread.start":
          return {
            ok: true,
            result: { providerThreadId: `provider-${command.threadId}` },
          };
        case "turn.submit":
          return { ok: true, result: { trace: { spans: [] } } };
        default:
          throw new Error(`Unexpected command ${command.type}`);
      }
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

  it("rechecks a model PATCH after catalog loading before committing the override", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      let enteredCatalog: () => void = () => undefined;
      const catalogEntered = new Promise<void>((resolve) => {
        enteredCatalog = resolve;
      });
      let releaseCatalog: () => void = () => undefined;
      const catalogGate = new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async () => {
          enteredCatalog();
          await catalogGate;
          return {
            ok: true,
            result: {
              models: [availableModelFixture({ model: "claude-opus-5-5" })],
              selectedOnlyModels: [],
            },
          } satisfies HostRpcHandlerResult;
        },
      });

      const modelPatch = patchThread(harness, thread.id, {
        model: "claude-opus-5-5",
      });
      await Promise.race([
        catalogEntered,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Provider catalog request did not arrive")),
            5_000,
          );
        }),
      ]);
      const parentPatch = await patchThread(harness, thread.id, {
        parentThreadId: parent.id,
      });
      expect(parentPatch.status).toBe(200);
      releaseCatalog();
      const response = await modelPatch;

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(parent.id);
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });

  it("rechecks a parent PATCH against the latest override after catalog loading", async () => {
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
      const registry = harness.deps.providerRegistry;
      const originalWhenSettled =
        registry.whenRegistrationsSettled.bind(registry);
      let readinessCalls = 0;
      let releaseRouteCommit: () => void = () => undefined;
      let reachedRouteCommit: () => void = () => undefined;
      const routeCommitReached = new Promise<void>((resolve) => {
        reachedRouteCommit = resolve;
      });
      const routeCommitGate = new Promise<void>((resolve) => {
        releaseRouteCommit = resolve;
      });
      registry.whenRegistrationsSettled = () => {
        readinessCalls += 1;
        if (readinessCalls === 2) {
          reachedRouteCommit();
          return routeCommitGate;
        }
        return originalWhenSettled();
      };

      const parentPatch = patchThread(harness, thread.id, {
        parentThreadId: parent.id,
        reasoningLevel: "high",
      });
      await Promise.race([
        routeCommitReached,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error("Parent PATCH did not reach its commit boundary"),
              ),
            5_000,
          );
        }),
      ]);
      const modelPatch = await patchThread(harness, thread.id, {
        model: "claude-opus-5-5",
      });
      expect(modelPatch.status).toBe(200);
      releaseRouteCommit();
      const response = await parentPatch;

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBeNull();
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
    });
  });

  it("allows native terminal child model updates without managed child policy", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
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
      });
      createNativeTerminalThread(harness.db, {
        threadId: child.id,
        providerId: "claude-code",
        nativeSessionId: "native-child-patch-session",
        initialPrompt: null,
        initialImages: [],
        model: "claude-opus-5-5",
      });
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-5-5",
      );

      const response = await patchThread(harness, child.id, {
        model: "claude-opus-5-5",
      });

      expect(response.status).toBe(200);
      expect(getThreadExecutionOverride(harness.db, child.id)).toEqual({
        modelOverride: "claude-opus-5-5",
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

  it("refuses a new child policy that would substitute an accepted scheduled model", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThread(harness);
      const parent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [
          { type: "text", text: "scheduled accepted work", mentions: [] },
        ],
        model: "claude-opus-5-5",
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 60_000,
      });

      const response = await patchThread(harness, thread.id, {
        parentThreadId: parent.id,
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
        details: {
          reason: "parent",
          requestedModel: "claude-opus-5-5",
          queuedMessageIds: [queued.id],
        },
      });
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBeNull();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { id: queued.id, model: "claude-opus-5-5" },
      ]);
    });
  });

  it("allows a same-policy child reparent without rewriting accepted queue work", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThread(harness);
      const firstParent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      const secondParent = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
      });
      const child = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: thread.providerId,
        parentThreadId: firstParent.id,
      });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: child.id,
        content: [{ type: "text", text: "accepted child work", mentions: [] }],
        model: "claude-opus-5-5",
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 60_000,
      });

      const response = await patchThread(harness, child.id, {
        parentThreadId: secondParent.id,
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, child.id)?.parentThreadId).toBe(
        secondParent.id,
      );
      expect(listQueuedThreadMessages(harness.db, child.id)).toMatchObject([
        { id: queued.id, model: "claude-opus-5-5" },
      ]);
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
      setThreadExecutionOverride(harness.db, {
        threadId: child.id,
        modelOverride: "claude-sonnet-5-5",
        reasoningLevelOverride: null,
      });
      const eventCount = listEvents(harness.db, { threadId: child.id }).length;

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
      expect(getThreadExecutionOverride(harness.db, child.id)).toEqual({
        modelOverride: "claude-sonnet-5-5",
        reasoningLevelOverride: null,
      });
      expect(listEvents(harness.db, { threadId: child.id })).toHaveLength(
        eventCount,
      );
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

describe("POST /threads/:id/send execution override recovery", () => {
  it("preserves caller intent for managed children and base recovery for top-level sends", async () => {
    await withTestHarness(async (harness) => {
      const top = seedProviderThread(harness);
      registerSendHostResponder(harness, top.host.id, top.session.id);
      setThreadExecutionOverride(harness.db, {
        threadId: top.thread.id,
        modelOverride: "claude-sonnet-5-5",
        reasoningLevelOverride: "high",
      });
      const topResponse = await harness.app.request(
        `/api/v1/threads/${top.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [
              { type: "text", text: "top-level preference", mentions: [] },
            ],
            mode: "auto",
            model: "claude-opus-5-5",
            reasoningLevel: "low",
            executionInputSources: {
              model: "client-preference",
              reasoningLevel: "client-preference",
            },
          }),
        },
      );
      expect(topResponse.status, await topResponse.text()).toBe(200);
      expect(
        getThreadExecutionOverride(harness.db, top.thread.id)?.modelOverride,
      ).toBe("claude-opus-5-5");
      expect(
        getThreadExecutionOverride(harness.db, top.thread.id)
          ?.reasoningLevelOverride,
      ).toBe("low");
      const topRequest = listEvents(harness.db, { threadId: top.thread.id })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      expect(
        turnRequestEventDataSchema.parse(JSON.parse(topRequest!.data))
          .execution,
      ).toMatchObject({ model: "claude-opus-5-5", reasoningLevel: "low" });

      const child = seedProviderThread(harness);
      registerSendHostResponder(harness, child.host.id, child.session.id);
      const parent = seedThread(harness.deps, {
        projectId: child.thread.projectId,
        environmentId: child.thread.environmentId,
        providerId: "claude-code",
      });
      const managedChild = updateThread(
        harness.db,
        harness.hub,
        child.thread.id,
        {
          parentThreadId: parent.id,
        },
      )!;
      setThreadExecutionOverride(harness.db, {
        threadId: managedChild.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
      const tellResponse = await harness.app.request(
        `/api/v1/threads/${managedChild.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "ordinary tell", mentions: [] }],
            mode: "auto",
          }),
        },
      );
      expect(tellResponse.status, await tellResponse.text()).toBe(200);
      expect(
        getThreadExecutionOverride(harness.db, managedChild.id)?.modelOverride,
      ).toBe("claude-opus-5-5");
      const tellRequest = listEvents(harness.db, { threadId: managedChild.id })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      expect(
        turnRequestEventDataSchema.parse(JSON.parse(tellRequest!.data))
          .execution.model,
      ).toBe("claude-sonnet-5-5");

      const explicitChild = seedProviderThread(harness);
      registerSendHostResponder(
        harness,
        explicitChild.host.id,
        explicitChild.session.id,
      );
      const explicitParent = seedThread(harness.deps, {
        projectId: explicitChild.thread.projectId,
        environmentId: explicitChild.thread.environmentId,
        providerId: "claude-code",
      });
      const explicitManagedChild = updateThread(
        harness.db,
        harness.hub,
        explicitChild.thread.id,
        { parentThreadId: explicitParent.id },
      )!;
      setThreadExecutionOverride(harness.db, {
        threadId: explicitManagedChild.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
      const compatibleResponse = await harness.app.request(
        `/api/v1/threads/${explicitManagedChild.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [
              { type: "text", text: "explicit child model", mentions: [] },
            ],
            mode: "auto",
            model: "claude-sonnet-5-5",
            executionInputSources: { model: "explicit" },
          }),
        },
      );
      expect(compatibleResponse.status, await compatibleResponse.text()).toBe(
        200,
      );
      expect(
        getThreadExecutionOverride(harness.db, explicitManagedChild.id)
          ?.modelOverride,
      ).toBe("claude-sonnet-5-5");
      const compatibleRequest = listEvents(harness.db, {
        threadId: explicitManagedChild.id,
      })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      expect(
        turnRequestEventDataSchema.parse(JSON.parse(compatibleRequest!.data))
          .execution.model,
      ).toBe("claude-sonnet-5-5");

      const omittedSourcesChild = seedProviderThread(harness);
      registerSendHostResponder(
        harness,
        omittedSourcesChild.host.id,
        omittedSourcesChild.session.id,
      );
      const omittedSourcesParent = seedThread(harness.deps, {
        projectId: omittedSourcesChild.thread.projectId,
        environmentId: omittedSourcesChild.thread.environmentId,
        providerId: "claude-code",
      });
      const omittedSourcesManagedChild = updateThread(
        harness.db,
        harness.hub,
        omittedSourcesChild.thread.id,
        { parentThreadId: omittedSourcesParent.id },
      )!;
      setThreadExecutionOverride(harness.db, {
        threadId: omittedSourcesManagedChild.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
      const omittedSourcesResponse = await harness.app.request(
        `/api/v1/threads/${omittedSourcesManagedChild.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [
              {
                type: "text",
                text: "model with omitted sources",
                mentions: [],
              },
            ],
            mode: "auto",
            model: "claude-sonnet-5-5",
          }),
        },
      );
      expect(
        omittedSourcesResponse.status,
        await omittedSourcesResponse.text(),
      ).toBe(200);
      expect(
        getThreadExecutionOverride(harness.db, omittedSourcesManagedChild.id)
          ?.modelOverride,
      ).toBe("claude-sonnet-5-5");
      const omittedSourcesRequest = listEvents(harness.db, {
        threadId: omittedSourcesManagedChild.id,
      })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      expect(
        turnRequestEventDataSchema.parse(
          JSON.parse(omittedSourcesRequest!.data),
        ).execution.model,
      ).toBe("claude-sonnet-5-5");

      const partialSourcesChild = seedProviderThread(harness);
      registerSendHostResponder(
        harness,
        partialSourcesChild.host.id,
        partialSourcesChild.session.id,
      );
      const partialSourcesParent = seedThread(harness.deps, {
        projectId: partialSourcesChild.thread.projectId,
        environmentId: partialSourcesChild.thread.environmentId,
        providerId: "claude-code",
      });
      const partialSourcesManagedChild = updateThread(
        harness.db,
        harness.hub,
        partialSourcesChild.thread.id,
        { parentThreadId: partialSourcesParent.id },
      )!;
      setThreadExecutionOverride(harness.db, {
        threadId: partialSourcesManagedChild.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
      const partialSourcesResponse = await harness.app.request(
        `/api/v1/threads/${partialSourcesManagedChild.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [
              {
                type: "text",
                text: "model with partial sources",
                mentions: [],
              },
            ],
            mode: "auto",
            model: "claude-sonnet-5-5",
            executionInputSources: { reasoningLevel: "explicit" },
          }),
        },
      );
      expect(
        partialSourcesResponse.status,
        await partialSourcesResponse.text(),
      ).toBe(200);
      expect(
        getThreadExecutionOverride(harness.db, partialSourcesManagedChild.id)
          ?.modelOverride,
      ).toBe("claude-opus-5-5");
      const partialSourcesRequest = listEvents(harness.db, {
        threadId: partialSourcesManagedChild.id,
      })
        .filter((event) => event.type === "client/turn/requested")
        .at(-1);
      expect(
        turnRequestEventDataSchema.parse(
          JSON.parse(partialSourcesRequest!.data),
        ).execution.model,
      ).toBe("claude-sonnet-5-5");
    });
  });
});
