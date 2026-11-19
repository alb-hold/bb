import { eq } from "drizzle-orm";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  archiveThread,
  getThread,
  getThreadExecutionOverride,
  listEvents,
  listQueuedThreadMessages,
  recordThreadSpawner,
  setThreadExecutionOverride,
  threads,
  createProjectSource,
  getProjectExecutionDefaults,
  listThreadsWithPendingInteractionState,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { threadSchema } from "@bb/domain";
import { sidebarBootstrapResponseSchema } from "@bb/server-contract";
import {
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { seedModelCatalog } from "../helpers/provider-model-catalogs.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
  type HostRpcHandlerResult,
  registerProviderHostRpcResponder,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";
import { vi, describe, expect, it } from "vitest";

describe("public thread default routes", () => {
  it.each(["provider registration", "bridge artifact"] as const)(
    "waits for pending %s before accepting a valid Claude spawn",
    async (pending) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const registration = harness.deps.providerRegistry.get("claude-code");
        if (registration === null)
          throw new Error("Claude registration missing");
        const artifact = harness.deps.pluginHostArtifacts.get(
          registration.pluginId,
        );
        if (artifact === undefined) throw new Error("Claude artifact missing");
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
        });
        harness.deps.providerRegistry = registry;
        if (pending === "bridge artifact") {
          registry.register(registration);
          harness.deps.pluginHostArtifacts.delete(registration.pluginId);
        }
        const whenSettled = registry.whenRegistrationsSettled.bind(registry);
        const readinessReached = new Promise<void>((resolve) => {
          vi.spyOn(registry, "whenRegistrationsSettled").mockImplementation(
            async () => {
              resolve();
              await whenSettled();
            },
          );
        });
        const create = Promise.resolve(
          harness.app.request("/api/v1/threads", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              origin: "cli",
              projectId: project.id,
              providerId: "claude-code",
              model: "claude-opus-5-5",
              input: [{ type: "text", text: "Start after registration" }],
              environment: { type: "reuse", environmentId: environment.id },
            }),
          }),
        );
        try {
          expect(
            await Promise.race([
              readinessReached.then(() => "waiting"),
              create.then(() => "responded"),
            ]),
          ).toBe("waiting");
          expect(
            harness.db
              .select()
              .from(threads)
              .where(eq(threads.projectId, project.id))
              .all(),
          ).toEqual([]);
          expect(listQueuedThreadCommands(harness, "thread.start")).toEqual([]);
          if (pending === "provider registration") {
            registry.register(registration);
          } else {
            harness.deps.pluginHostArtifacts.set(
              registration.pluginId,
              artifact,
            );
          }
        } finally {
          registry.markRegistrationsSettled();
        }
        const response = await create;
        expect(response.status).toBe(201);
        const created = threadSchema.parse(await readJson(response));
        expect(getThread(harness.db, created.id)?.providerId).toBe(
          "claude-code",
        );
        const start = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === created.id,
        );
        expect(start.command).toMatchObject({
          options: { model: "claude-opus-5-5" },
        });
      });
    },
  );

  it.each([
    { providerId: "claude", status: 400, code: "invalid_request" },
    {
      providerId: "claude-code",
      status: 409,
      code: "provider_bridge_unavailable",
    },
  ])(
    "rejects unavailable provider $providerId before creating a thread",
    async ({ providerId, status, code }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        if (providerId === "claude-code")
          vi.spyOn(harness.deps.pluginHostArtifacts, "get").mockReturnValue(
            undefined,
          );
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            providerId,
            model: "claude-opus-5-5",
            input: [{ type: "text", text: "Start" }],
            environment: { type: "reuse", environmentId: environment.id },
          }),
        });
        expect(response.status).toBe(status);
        const body = await readJson(response);
        expect(body).toMatchObject({ code });
        expect(JSON.stringify(body)).toContain("claude-code");
        expect(
          harness.db
            .select()
            .from(threads)
            .where(eq(threads.projectId, project.id))
            .all(),
        ).toEqual([]);
        expect(listQueuedThreadCommands(harness, "thread.start")).toEqual([]);
      });
    },
  );

  it("remembers resolved execution options after thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      await seedModelCatalog(harness, {
        hostId: host.id,
        providerId: "codex",
        models: [
          availableModelFixture({
            model: "gpt-5-mini",
            reasoningLevels: ["high"],
          }),
        ],
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-create",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-create",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "workspace-write",
          input: [
            { type: "text", text: "Create with explicit execution options" },
          ],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });
    });
  });

  it("allows managed-worktree threads on a secondary host", async () => {
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host: localHost } = seedHostSession(harness.deps, {
        id: "host-managed-default",
      });
      seedPrimaryHost(harness.deps, localHost.id);
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-managed-secondary",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: localHost.id,
        path: "/tmp/default-managed-source",
      });
      createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/secondary-managed-source",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Secondary host thread",
          input: [{ type: "text", text: "Build it on the secondary host" }],
          environment: {
            type: "host",
            hostId: secondaryHost.id,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      const context = await provider.waitForProvision();
      expect(context.thread.id).toBe(thread.id);
      expect(context.host?.id).toBe(secondaryHost.id);
      expect(context.inputs).toEqual({ branch: { kind: "default" } });
    });
  });

  it("does not remember project defaults after CLI-origin thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-cli-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-cli-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "workspace-write",
          input: [
            { type: "text", text: "Create without mutating project defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("inherits the remembered provider and execution defaults when thread creation omits them", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      await seedModelCatalog(harness, {
        hostId: host.id,
        providerId: "codex",
        models: [
          availableModelFixture({ model: "gpt-5", reasoningLevels: ["high"] }),
        ],
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-inherit",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-inherit",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create with inherited defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
    });
  });

  it("uses the explicit provider catalog default when stored defaults belong to another provider", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          "claude-code": {
            models: [
              availableModelFixture({
                model: "claude-opus-catalog-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "claude-code",
          input: [
            { type: "text", text: "Create with mismatched provider defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: { model: "claude-opus-catalog-default" },
      });
    });
  });

  it.each([
    {
      name: "child without a model",
      parent: true,
      model: undefined,
      expected: "claude-sonnet-5-5",
    },
    {
      name: "child explicitly naming Opus",
      parent: true,
      model: "claude-opus-5-5",
      expected: "claude-opus-5-5",
    },
    {
      name: "spawned top-level thread explicitly naming Opus",
      parent: false,
      spawnedBy: "active",
      model: "claude-opus-5-5",
      expected: "claude-opus-5-5",
    },
    {
      name: "spawned top-level thread without a model",
      parent: false,
      spawnedBy: "active",
      model: undefined,
      expected: "claude-sonnet-5-5",
    },
    {
      name: "child explicitly naming the provider child model",
      parent: true,
      model: "claude-sonnet-5-5",
      expected: "claude-sonnet-5-5",
    },
    {
      name: "child with a client-preference model",
      parent: true,
      model: "claude-opus-5-5",
      source: "client-preference",
      expected: "claude-sonnet-5-5",
    },
    {
      name: "top-level thread naming Opus",
      parent: false,
      model: "claude-opus-5-5",
      expected: "claude-opus-5-5",
    },
    {
      name: "top-level thread without a model",
      parent: false,
      model: undefined,
      expected: "claude-opus-5-5",
    },
    ...(["missing", "idle", "other-project", "archived"] as const).map(
      (spawnedBy) => ({
        name: `top-level thread naming a ${spawnedBy} spawner`,
        parent: false,
        spawnedBy,
        model: "claude-opus-5-5",
        expected: "claude-opus-5-5",
      }),
    ),
  ] as Array<{
    name: string;
    parent: boolean;
    spawnedBy?: "active" | "missing" | "idle" | "other-project" | "archived";
    model: string | undefined;
    source?: "client-preference";
    expected: string;
  }>)(
    "starts a Claude $name on $expected",
    async ({ parent, spawnedBy, model, source, expected }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/thread-defaults-claude-child",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/thread-defaults-claude-child",
        });
        upsertProjectExecutionDefaults(harness.db, {
          projectId: project.id,
          providerId: "claude-code",
          model: "claude-opus-5-5",
          serviceTier: "default",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
        });
        const parentThread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
        });
        const spawnedByThreadId = seedSpawner(harness, {
          kind: spawnedBy,
          projectId: project.id,
          hostId: host.id,
        });

        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            providerId: "claude-code",
            ...(model !== undefined ? { model } : {}),
            ...(source !== undefined
              ? { executionInputSources: { model: source } }
              : {}),
            input: [{ type: "text", text: "Review the change" }],
            environment: { type: "reuse", environmentId: environment.id },
            ...(parent ? { parentThreadId: parentThread.id } : {}),
            ...(spawnedByThreadId === undefined ? {} : { spawnedByThreadId }),
          }),
        });

        expect(response.status).toBe(201);
        const createdThread = threadSchema.parse(await readJson(response));
        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" &&
            command.threadId === createdThread.id,
        );
        expect(queuedStart.command).toMatchObject({
          options: { model: expected, reasoningLevel: "high" },
        });
        await reportQueuedCommandSuccess(harness, queuedStart, {
          providerThreadId: `provider-${createdThread.id}`,
        });
        seedThreadRuntimeState(harness.deps, {
          threadId: createdThread.id,
          environmentId: environment.id,
          providerThreadId: `provider-${createdThread.id}`,
          sequenceStart: 1000,
          model: expected,
          reasoningLevel: "high",
        });
        applyLoggedThreadLifecycleEvent(harness.deps, {
          threadId: createdThread.id,
          event: { type: "run.succeeded" },
        });
        const followup = await harness.app.request(
          `/api/v1/threads/${createdThread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "Continue on the chosen model" }],
              mode: "auto",
            }),
          },
        );
        expect(followup.status, await followup.text()).toBe(200);
        const submit = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === createdThread.id,
        );
        expect(submit.command).toMatchObject({
          options: { model: expected, reasoningLevel: "high" },
        });
      });
    },
  );

  it("accepts the persisted child model when handling the standalone clear command", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: true, result: { providerCheckpointId: null } }),
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-clear-conflict",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-clear-conflict",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        parentThreadId: parent.id,
        status: "idle",
      });
      setThreadExecutionOverride(harness.db, {
        threadId: child.id,
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: null,
      });
      const input = [
        {
          type: "text" as const,
          text: "/clear",
          mentions: [
            {
              start: 0,
              end: 6,
              resource: {
                kind: "command" as const,
                trigger: "/",
                name: "clear",
                source: "command" as const,
                origin: "builtin" as const,
                label: "clear",
                argumentHint: null,
              },
            },
          ],
        },
      ];

      const response = await harness.app.request(
        `/api/v1/threads/${child.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            model: "claude-opus-5-5",
            mode: "auto",
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", child.id),
      ).toEqual([]);
    });
  });

  it("accepts an explicit child model over the provider default", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-child-conflict-counterfactual",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-child-conflict-counterfactual",
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "claude-code",
          parentThreadId: parentThread.id,
          model: "claude-opus-5-5",
          input: [{ type: "text", text: "Review the change" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(response.status).toBe(201);
      const created = threadSchema.parse(await readJson(response));
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === created.id,
      );
      expect(start.command).toMatchObject({
        options: { model: "claude-opus-5-5" },
      });
    });
  });

  it("treats a model with present sources but no model source as implicit on child create", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-source-without-model-create",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-source-without-model-create",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "claude-code",
          parentThreadId: parent.id,
          model: "claude-opus-5-5",
          executionInputSources: { providerId: "explicit" },
          input: [{ type: "text", text: "Create child from untouched picker" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(response.status).toBe(201);
      const child = threadSchema.parse(await readJson(response));
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === child.id,
      );
      expect(start.command).toMatchObject({
        options: { model: "claude-sonnet-5-5" },
      });
    });
  });

  it("accepts an explicit model for an active thread spawner", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-spawner-conflict",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-spawner-conflict",
      });
      const spawnerThreadId = seedSpawner(harness, {
        kind: "active",
        projectId: project.id,
        hostId: host.id,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "claude-code",
          spawnedByThreadId: spawnerThreadId,
          model: "claude-opus-5-5",
          input: [{ type: "text", text: "Review the change" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(response.status).toBe(201);
      const created = threadSchema.parse(await readJson(response));
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === created.id,
      );
      expect(start.command).toMatchObject({
        options: { model: "claude-opus-5-5" },
      });
    });
  });

  it("keeps the explicit model when a spawner becomes active between precheck and insert", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-spawner-race",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-spawner-race",
      });
      const spawnerThreadId = seedSpawner(harness, {
        kind: "idle",
        projectId: project.id,
        hostId: host.id,
      });
      if (spawnerThreadId === undefined) throw new Error("Spawner missing");
      const registry = harness.deps.providerRegistry;
      const whenRegistrationsSettled =
        registry.whenRegistrationsSettled.bind(registry);
      let settleCount = 0;
      registry.whenRegistrationsSettled = async () => {
        await whenRegistrationsSettled();
        settleCount += 1;
        if (settleCount === 2) {
          harness.db
            .update(threads)
            .set({ status: "active" })
            .where(eq(threads.id, spawnerThreadId))
            .run();
        }
      };

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "claude-code",
          spawnedByThreadId: spawnerThreadId,
          model: "claude-opus-5-5",
          input: [{ type: "text", text: "Review the change" }],
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(response.status).toBe(201);
      const created = threadSchema.parse(await readJson(response));
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === created.id,
      );
      expect(start.command).toMatchObject({
        options: { model: "claude-opus-5-5" },
      });
    });
  });

  it.each([
    { name: "child", parent: true, expected: "claude-opus-5-5" },
    { name: "top-level thread", parent: false, expected: "claude-opus-5-5" },
    {
      name: "top-level thread another thread spawned",
      parent: false,
      spawned: true,
      expected: "claude-opus-5-5",
    },
  ] as Array<{
    name: string;
    parent: boolean;
    spawned?: boolean;
    expected: string;
  }>)(
    "runs a Claude $name's follow-up naming Opus on $expected",
    async ({ parent, spawned, expected }) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: ({ command }) => {
            if (command.type === "provider.list_models")
              return {
                ok: true,
                result: {
                  models: [
                    availableModelFixture({
                      model: "claude-opus-5-5",
                      reasoningLevels: ["high"],
                    }),
                  ],
                  selectedOnlyModels: [],
                },
              };
            if (command.type === "host.read_workspace_agent_context")
              return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
            return { ok: true, result: { trace: { spans: [] } } };
          },
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/thread-defaults-claude-followup",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/thread-defaults-claude-followup",
        });
        const parentThread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          environmentId: environment.id,
          projectId: project.id,
          providerId: "claude-code",
          parentThreadId: parent ? parentThread.id : null,
          status: "idle",
        });
        if (spawned) {
          recordThreadSpawner(harness.db, {
            threadId: thread.id,
            spawnedByThreadId: parentThread.id,
          });
        }
        seedThreadRuntimeState(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-claude-followup",
        });
        if (parent || spawned) {
          setThreadExecutionOverride(harness.db, {
            threadId: thread.id,
            modelOverride: "claude-opus-5-5",
            reasoningLevelOverride: null,
          });
        }
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "Keep going", mentions: [] }],
              mode: "steer-if-active",
              model: "claude-opus-5-5",
              permissionMode: "full",
              reasoningLevel: "high",
              serviceTier: "default",
            }),
          },
        );

        expect(response.status).toBe(200);
        const dispatched = responder.requests.find(
          ({ command }) =>
            command.type === "turn.submit" && command.threadId === thread.id,
        );
        expect(dispatched?.command).toMatchObject({
          options: { model: expected, reasoningLevel: "high" },
        });
      });
    },
  );

  it("uses the requested provider's remembered defaults after another provider was used", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-per-provider",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-per-provider",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "claude-code",
        model: "claude-remembered",
        serviceTier: "default",
        reasoningLevel: "low",
        permissionMode: "auto",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "claude-code",
          input: [{ type: "text", text: "Create with remembered defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: { model: "claude-remembered", reasoningLevel: "low" },
      });
    });
  });

  it("treats a model with present sources but no model source as implicit on child send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-source-without-model-send",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-source-without-model-send",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        parentThreadId: parent.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: child.id,
        providerThreadId: "provider-claude-source-without-model",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${child.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Send from untouched picker" }],
            model: "claude-opus-5-5",
            executionInputSources: { reasoningLevel: "explicit" },
            mode: "auto",
          }),
        },
      );

      expect(response.status).toBe(200);
      const submit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === child.id,
      );
      expect(submit.command).toMatchObject({
        options: { model: "claude-sonnet-5-5" },
      });
    });
  });

  it("refuses an explicit inline model when parent scope changes during recovery", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-send-parent-race",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-send-parent-race",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        providerThreadId: "provider-claude-send-parent-race",
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-sonnet-5-5",
        reasoningLevelOverride: null,
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
      let enteredCatalog: () => void = () => undefined;
      const catalogEntered = new Promise<void>((resolve) => {
        enteredCatalog = resolve;
      });
      let releaseCatalog: () => void = () => undefined;
      const catalogGate = new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      });

      const send = harness.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "auto",
          input: [
            {
              type: "text",
              text: "Append only under the checked scope",
              mentions: [],
            },
          ],
          model: "claude-opus-5-5",
        }),
      });
      let catalogTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          catalogEntered,
          new Promise<never>((_, reject) => {
            catalogTimeout = setTimeout(
              () =>
                reject(new Error("Send did not load its stored model catalog")),
              5_000,
            );
          }),
        ]);
      } catch (error) {
        releaseCatalog();
        throw error;
      } finally {
        if (catalogTimeout !== undefined) clearTimeout(catalogTimeout);
      }
      const parentPatch = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentThreadId: parent.id }),
        },
      );
      expect(parentPatch.status).toBe(200);
      const eventsBeforeRelease = listEvents(harness.db, {
        threadId: thread.id,
      });
      releaseCatalog();
      const response = await send;

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        eventsBeforeRelease,
      );
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-sonnet-5-5",
        reasoningLevelOverride: null,
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("refuses an explicit inline model when parent scope changes after resolution", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-send-parent-append-race",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-send-parent-append-race",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        providerThreadId: "provider-claude-send-parent-append-race",
      });

      const registry = harness.deps.providerRegistry;
      const originalWhenSettled =
        registry.whenRegistrationsSettled.bind(registry);
      let readinessCalls = 0;
      let releasePreparation: () => void = () => undefined;
      let reachedPreparation: () => void = () => undefined;
      const preparationReached = new Promise<void>((resolve) => {
        reachedPreparation = resolve;
      });
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      registry.whenRegistrationsSettled = () => {
        readinessCalls += 1;
        if (readinessCalls === 4) {
          reachedPreparation();
          return preparationGate;
        }
        return originalWhenSettled();
      };

      const send = harness.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "auto",
          input: [
            {
              type: "text",
              text: "Append only under the checked scope",
              mentions: [],
            },
          ],
          model: "claude-opus-5-5",
        }),
      });
      let preparationTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          preparationReached,
          new Promise<never>((_, reject) => {
            preparationTimeout = setTimeout(
              () =>
                reject(
                  new Error(
                    `Send did not reach final preparation (${readinessCalls} waits)`,
                  ),
                ),
              5_000,
            );
          }),
        ]);
      } catch (error) {
        releasePreparation();
        throw error;
      } finally {
        if (preparationTimeout !== undefined) clearTimeout(preparationTimeout);
      }

      const parentPatch = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentThreadId: parent.id }),
        },
      );
      expect(parentPatch.status).toBe(200);
      const eventsBeforeRelease = listEvents(harness.db, {
        threadId: thread.id,
      });
      releasePreparation();
      const response = await send;

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "child_model_conflict",
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        eventsBeforeRelease,
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("returns a retryable scope error when parent scope changes twice", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-send-parent-repeat-race",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-send-parent-repeat-race",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      const firstParent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      const secondParent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        providerThreadId: "provider-claude-send-parent-repeat-race",
      });

      const registry = harness.deps.providerRegistry;
      const originalWhenSettled =
        registry.whenRegistrationsSettled.bind(registry);
      let readinessCalls = 0;
      registry.whenRegistrationsSettled = async () => {
        readinessCalls += 1;
        if (readinessCalls === 2 || readinessCalls === 5) {
          harness.db
            .update(threads)
            .set({
              parentThreadId:
                readinessCalls === 2 ? firstParent.id : secondParent.id,
            })
            .where(eq(threads.id, thread.id))
            .run();
        }
        await originalWhenSettled();
      };
      const eventsBeforeRequest = listEvents(harness.db, {
        threadId: thread.id,
      });

      const send = harness.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "auto",
          input: [
            {
              type: "text",
              text: "Retry under current policy",
              mentions: [],
            },
          ],
          model: "claude-opus-5-5",
          executionInputSources: { model: "client-preference" },
        }),
      });
      const response = await send;

      expect(readinessCalls).toBeGreaterThanOrEqual(5);
      expect(response.status).toBe(409);
      expect(await readJson(response)).toMatchObject({
        code: "thread_scope_changed",
      });
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(
        secondParent.id,
      );
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        eventsBeforeRequest,
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("answers the defaults route for a named provider", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-route-provider",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "claude-code",
        model: "claude-remembered",
        serviceTier: "default",
        reasoningLevel: "low",
        permissionMode: "auto",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });
      const read = async (query: string) => {
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/default-execution-options${query}`,
        );
        expect(response.status).toBe(200);
        return readJson(response);
      };

      expect(await read("?providerId=claude-code")).toMatchObject({
        providerId: "claude-code",
        model: "claude-remembered",
        reasoningLevel: "low",
      });
      expect(await read("")).toMatchObject({
        providerId: "codex",
        model: "gpt-5",
      });
      expect(await read("?providerId=never-used")).toBeNull();
    });
  });

  it("uses the catalog isDefault model when provider and project defaults are omitted", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const providerResponder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({ model: "gpt-first" }),
              availableModelFixture({
                model: "gpt-provider-default",
                reasoningLevels: ["medium"],
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "codex",
        options: { model: "gpt-provider-default" },
      });
      expect(
        providerResponder.requests.map((request) => request.command),
      ).toMatchObject([
        {
          type: "provider.list_models",
          providerId: "codex",
        },
      ]);
      expect(providerResponder.requests[0].command).not.toHaveProperty("cwd");
    });
  });

  it("creates from displayed execution values when only the provider has a client source", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({
                model: "gpt-provider-default",
                reasoningLevels: ["medium"],
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-client-provider",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-client-provider",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-provider-default",
          reasoningLevel: "medium",
          permissionMode: "auto",
          executionInputSources: {
            providerId: "client-preference",
          },
          input: [
            { type: "text", text: "Create from the new thread composer" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "codex",
        options: {
          model: "gpt-provider-default",
          reasoningLevel: "medium",
          permissionMode: "auto",
        },
      });
    });
  });

  it("returns an actionable error when an explicitly requested provider's model catalog cannot be loaded", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          codex: {
            errorCode: "command_failed",
            errorMessage: "Codex model discovery failed",
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-catalog-error",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-catalog-error",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(503);
      await expect(readJson(response)).resolves.toEqual({
        code: "model_catalog_unavailable",
        message: expect.stringContaining("Unable to load codex models"),
        details: {
          providerId: "codex",
          code: "failed",
          detail: "Codex model discovery failed",
        },
        retryable: true,
      });
      expect(
        listThreadsWithPendingInteractionState(harness.db, {
          projectId: project.id,
        }),
      ).toHaveLength(0);
    });
  });

  it.each(["failed", "empty"])(
    "falls back to another available provider when the product default's model catalog is %s",
    async (catalogState) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          restoreCommandCaptureAfterResponse: true,
          modelsByProviderId:
            catalogState === "empty"
              ? { codex: { models: [], selectedOnlyModels: [] } }
              : {},
          modelErrorsByProviderId:
            catalogState === "failed"
              ? {
                  codex: {
                    errorCode: "command_failed",
                    errorMessage: "Codex model discovery failed",
                  },
                }
              : {},
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/thread-defaults-catalog-fallback",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/thread-defaults-catalog-fallback",
        });

        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            input: [{ type: "text", text: "Create without defaults" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        });

        expect(response.status).toBe(201);
        const createdThread = threadSchema.parse(await readJson(response));
        expect(createdThread.providerId).toBe("claude-code");
        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" &&
            command.threadId === createdThread.id,
        );
        expect(queuedStart.command).toMatchObject({
          providerId: "claude-code",
          options: { model: "test-provider-default" },
        });
      });
    },
  );

  it("rejects thread creation without an origin at the public API boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          input: [{ type: "text", text: "Create without origin" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining('expected one of "app"|"cli"'),
      });
    });
  });

  it("does not overwrite project execution defaults after a thread send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      await seedModelCatalog(harness, {
        hostId: host.id,
        providerId: "codex",
        models: [
          availableModelFixture({
            model: "gpt-5-mini",
            reasoningLevels: ["high"],
          }),
        ],
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-send-defaults",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-send-defaults",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-send-defaults",
        model: "gpt-5",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: thread.providerId,
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Use explicit send defaults" }],
            model: "gpt-5-mini",
            serviceTier: "fast",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedRun = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedRun.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    });
  });

  it("does not synthesize project defaults in sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.defaultExecutionOptions).toBeNull();
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("excludes hidden threads from sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar-hidden",
      });
      const visibleThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Visible thread",
      });
      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Hidden worker",
        visibility: "hidden",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).toContain(
        visibleThread.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).not.toContain(
        hiddenThread.id,
      );
    });
  });
});

// A spawner the server should believe (mid-turn, same project) or one of the
// kinds it must ignore.
function seedSpawner(
  harness: TestAppHarness,
  args: {
    kind:
      | "active"
      | "missing"
      | "idle"
      | "other-project"
      | "archived"
      | undefined;
    projectId: string;
    hostId: string;
  },
): string | undefined {
  switch (args.kind) {
    case undefined:
      return undefined;
    case "missing":
      return "thr_missing";
    case "other-project": {
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: args.hostId,
        path: "/tmp/thread-defaults-other-project",
      });
      return seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      }).id;
    }
    case "archived": {
      const spawner = seedThread(harness.deps, {
        projectId: args.projectId,
        status: "active",
      });
      archiveThread(harness.db, harness.deps.hub, spawner.id);
      return spawner.id;
    }
    default:
      return seedThread(harness.deps, {
        projectId: args.projectId,
        status: args.kind,
      }).id;
  }
}
