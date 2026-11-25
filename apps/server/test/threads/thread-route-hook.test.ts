import { getProjectExecutionDefaults } from "@bb/db";
import type {
  PluginHookHandler,
  PluginHookName,
  PluginHookSignatures,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import type { ThreadCreateServiceRequestInput } from "../../src/services/threads/thread-create-request.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { seedModelCatalog } from "../helpers/provider-model-catalogs.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

type RouteContext =
  PluginHookSignatures["experimental_thread.route"]["context"];
type RouteHandler = PluginHookHandler<"experimental_thread.route">;

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installRouteHook(
  handler: RouteHandler | null,
  decisionTimeoutMs = 10_000,
): void {
  const registry: HookRegistry = {
    "experimental_thread.configure": [],
    "experimental_thread.route":
      handler === null ? [] : [{ pluginId: "route-test", handler }],
    "message.dispatch": [],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_registration, _label, run) => invokePluginInline(run),
    decisionTimeoutMs,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

async function seedCreateTarget(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const path = "/tmp/route-hook";
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });
  seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
  });
  for (const providerId of ["codex", "claude-code"]) {
    await seedModelCatalog(harness, {
      hostId: host.id,
      providerId,
      models: [availableModelFixture({ model: `${providerId}-model` })],
    });
  }
  return {
    host,
    project,
    request: {
      environment: {
        type: "host" as const,
        hostId: host.id,
        workspace: { type: "unmanaged" as const, path },
      },
      input: textInput("route me"),
      origin: "app" as const,
      projectId: project.id,
      providerId: "codex",
      startedOnBehalfOf: null,
    } satisfies ThreadCreateServiceRequestInput,
  };
}

const toClaude: RouteHandler = () => ({
  providerId: "claude-code",
  model: "claude-code-model",
  reason: "balance",
});

describe("experimental_thread.route", () => {
  it("rewrites the provider and model from the first non-null decision", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      const seen: RouteContext[] = [];
      installRouteHook((context) => {
        seen.push(context);
        return toClaude(context);
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, {
        ...request,
        title: "Secret title",
      });
      expect(thread.providerId).toBe("claude-code");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        projectId: request.projectId,
        providerId: "codex",
        explicitProvider: true,
        origin: "app",
        originKind: null,
        inputText: "route me",
        title: "Secret title",
      });
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).toContain("codex -> claude-code");
      expect(lines).not.toContain("Secret title");
      expect(lines).not.toContain("route me");
    });
  });

  it("applies a model-only decision that keeps the provider", async () => {
    await withTestHarness(async (harness) => {
      const { host, request } = await seedCreateTarget(harness);
      await seedModelCatalog(harness, {
        hostId: host.id,
        providerId: "codex",
        models: [
          availableModelFixture({ model: "codex-model" }),
          availableModelFixture({ model: "codex-other-model" }),
        ],
      });
      installRouteHook(() => ({
        providerId: "codex",
        model: "codex-other-model",
        reason: "cheaper",
      }));
      const thread = await createThreadFromRequest(harness.deps, request);
      expect(thread.providerId).toBe("codex");
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected start command");
      }
      expect(start.command.options.model).toBe("codex-other-model");
    });
  });

  it("cuts inputText to 4000 characters", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      let length = -1;
      installRouteHook((context) => {
        length = context.inputText?.length ?? -1;
        return null;
      });
      await createThreadFromRequest(harness.deps, {
        ...request,
        input: textInput("x".repeat(9_000)),
      });
      expect(length).toBe(4_000);
    });
  });

  it("changes nothing when no hook is registered", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      installRouteHook(null);
      const thread = await createThreadFromRequest(harness.deps, request);
      expect(thread.providerId).toBe("codex");
    });
  });

  it("never consults the hook for a native-terminal create", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      const handler = vi.fn(toClaude);
      installRouteHook(handler);
      await createThreadFromRequest(harness.deps, {
        ...request,
        nativeTerminal: true,
      }).catch(() => undefined);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("never consults the hook for a fork", async () => {
    await withTestHarness(async (harness) => {
      const { project, request } = await seedCreateTarget(harness);
      const source = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "codex",
      });
      const handler = vi.fn(toClaude);
      installRouteHook(handler);
      await createThreadFromRequest(harness.deps, {
        ...request,
        originKind: "fork",
        sourceThreadId: source.id,
      }).catch(() => undefined);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  const keepsOriginal: {
    name: string;
    handler: RouteHandler;
    timeoutMs?: number;
  }[] = [
    {
      name: "a throwing hook",
      handler: () => {
        throw new Error("boom");
      },
    },
    {
      name: "a slow hook",
      handler: () => new Promise(() => undefined),
      timeoutMs: 20,
    },
    {
      name: "an unknown provider",
      handler: () => ({ providerId: "no-such-provider" }),
    },
    {
      name: "an invalid decision",
      handler: () => ({ providerId: 7 }) as never,
    },
  ];

  it.each(keepsOriginal)(
    "keeps the original provider for $name",
    async ({ handler, timeoutMs }) => {
      await withTestHarness(async (harness) => {
        const { request } = await seedCreateTarget(harness);
        installRouteHook(handler, timeoutMs);
        const warn = vi.spyOn(harness.deps.logger, "warn");
        const thread = await createThreadFromRequest(harness.deps, request);
        expect(thread.providerId).toBe("codex");
        expect(warn).toHaveBeenCalled();
      });
    },
  );

  it("does not overwrite the project default with a rerouted provider", async () => {
    await withTestHarness(async (harness) => {
      const { project, request } = await seedCreateTarget(harness);
      installRouteHook(null);
      await createThreadFromRequest(harness.deps, request);
      expect(
        getProjectExecutionDefaults(harness.db, { projectId: project.id })
          ?.providerId,
      ).toBe("codex");

      installRouteHook(toClaude);
      const thread = await createThreadFromRequest(harness.deps, {
        ...request,
        providerId: "codex",
      });
      expect(thread.providerId).toBe("claude-code");
      expect(
        getProjectExecutionDefaults(harness.db, { projectId: project.id })
          ?.providerId,
      ).toBe("codex");
    });
  });
});
