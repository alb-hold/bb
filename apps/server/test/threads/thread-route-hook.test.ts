import { getProjectExecutionDefaults } from "@bb/db";
import type {
  PluginHookHandler,
  PluginHookName,
  PluginHookSignatures,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
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

async function seedCreateTarget(
  harness: TestAppHarness,
  catalogProviders: readonly string[] = ["codex", "claude-code"],
) {
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
  for (const providerId of catalogProviders) {
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

  it("ignores a decision whose model the chosen provider does not have", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      installRouteHook(() => ({
        providerId: "claude-code",
        model: "no-such-model",
        reason: "balance",
      }));
      const warn = vi.spyOn(harness.deps.logger, "warn");
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
      expect(start.command.options.model).toBe("codex-model");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("no-such-model");
      expect(JSON.stringify(warn.mock.calls)).toContain("unlisted");
    });
  });

  it("applies the provider and the hook model when the catalog cannot be read", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness, ["codex"]);
      installRouteHook(() => ({
        providerId: "claude-code",
        model: "claude-code-model",
        reason: "balance",
      }));
      const requestHostOnlineRpc = harness.hub.requestHostOnlineRpc.bind(
        harness.hub,
      );
      vi.spyOn(harness.hub, "requestHostOnlineRpc").mockImplementation(
        async (args) => {
          if (
            args.message.command.type === "provider.list_models" &&
            args.message.command.providerId === "claude-code"
          ) {
            throw new ApiError(504, "command_timeout", "catalog down");
          }
          return requestHostOnlineRpc(args);
        },
      );
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, request);
      expect(thread.providerId).toBe("claude-code");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("keeping codex");
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      if (start.command.type !== "thread.start") {
        throw new Error("Expected start command");
      }
      expect(start.command.options.model).toBe("claude-code-model");
    });
  });

  it("never logs a reason that echoes the title or input text", async () => {
    for (const echo of ["title", "input"] as const) {
      await withTestHarness(async (harness) => {
        const { request } = await seedCreateTarget(harness);
        const title = "Patient Jane Doe needs a refill";
        installRouteHook((context) => ({
          providerId: "claude-code",
          model: "claude-code-model",
          reason: echo === "title" ? (context.title ?? "") : (context.inputText ?? ""),
        }));
        const info = vi.spyOn(harness.deps.logger, "info");
        const warn = vi.spyOn(harness.deps.logger, "warn");
        await createThreadFromRequest(harness.deps, { ...request, title });
        const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
        expect(lines).not.toContain(title);
        expect(lines).not.toContain("route me");
        expect(lines).toContain("reason_present");
      });
    }
  });

  it.each([
    ["throws the title", "title", "threw"],
    ["throws the input text", "input", "threw"],
    ["returns an error object carrying the title", "object", "invalid_decision"],
  ] as const)("never logs hook failure text when a hook %s", async (_name, mode, kind) => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      const title = "Patient Jane Doe needs a refill";
      installRouteHook((context) => {
        if (mode === "title") throw new Error(context.title ?? "");
        if (mode === "input") throw new Error(context.inputText ?? "");
        return { error: context.title } as never;
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, {
        ...request,
        title,
      });
      expect(thread.providerId).toBe("codex");
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).not.toContain(title);
      expect(lines).not.toContain("route me");
      expect(lines).toContain(kind);
    });
  });

  it("never logs the text of a plugin host invocation failure", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      const title = "Patient Jane Doe needs a refill";
      setPluginHookProvider({
        listHooks: (hook) =>
          hook === "experimental_thread.route"
            ? [{ pluginId: "route-test", handler: () => null }]
            : [],
        invokeHook: async () => ({ ok: false, error: title }),
        decisionTimeoutMs: 10_000,
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, {
        ...request,
        title,
      });
      expect(thread.providerId).toBe("codex");
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).not.toContain(title);
      expect(lines).toContain("host_error");
    });
  });

  it.each([
    ["error name", "name"],
    ["reason", "reason"],
    ["input-text reason", "inputReason"],
    ["provider id and model", "ids"],
  ] as const)("never logs a one-token hook value: %s", async (_label, mode) => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      const token = "HIV";
      installRouteHook((context) => {
        if (mode === "name") {
          const error = new Error("x");
          error.name = token;
          throw error;
        }
        if (mode === "reason") {
          return { providerId: "claude-code", model: "claude-code-model", reason: token };
        }
        if (mode === "inputReason") {
          return { providerId: "claude-code", model: "claude-code-model", reason: context.inputText ?? "" };
        }
        return { providerId: token, model: token, reason: "balance" };
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      await createThreadFromRequest(harness.deps, {
        ...request,
        title: token,
        input: textInput(token),
      });
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).not.toContain(token);
      if (mode === "name") expect(lines).toContain("threw");
      if (mode === "ids") expect(lines).toContain("unregistered");
    });
  });

  it.each([
    ["a throwing providerId getter", "provider"],
    ["a throwing model getter", "model"],
    ["a throwing Proxy", "proxy"],
  ] as const)("keeps the original provider when a decision has %s", async (_label, mode) => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      installRouteHook(() => {
        const boom = (): never => {
          throw new Error("HIV");
        };
        if (mode === "proxy") {
          return new Proxy({}, { get: boom, has: boom, ownKeys: boom }) as never;
        }
        const decision = { providerId: "claude-code", model: "claude-code-model" };
        Object.defineProperty(decision, mode === "provider" ? "providerId" : "model", {
          enumerable: true,
          get: boom,
        });
        return decision as never;
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, request);
      expect(thread.providerId).toBe("codex");
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).not.toContain("HIV");
      expect(lines).toContain("invalid_decision");
    });
  });

  it.each([
    ["rejects", "reject"],
    ["throws synchronously", "sync"],
  ] as const)("keeps the original provider when invokeHook %s", async (_label, mode) => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      setPluginHookProvider({
        listHooks: (hook) =>
          hook === "experimental_thread.route"
            ? [{ pluginId: "route-test", handler: () => null }]
            : [],
        invokeHook: (() => {
          if (mode === "sync") throw new Error("HIV");
          return Promise.reject(new Error("HIV"));
        }) as never,
        decisionTimeoutMs: 10_000,
      });
      const info = vi.spyOn(harness.deps.logger, "info");
      const warn = vi.spyOn(harness.deps.logger, "warn");
      const thread = await createThreadFromRequest(harness.deps, request);
      expect(thread.providerId).toBe("codex");
      const lines = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(lines).not.toContain("HIV");
      expect(lines).toContain("host_error");
    });
  });

  it("logs a benign reason", async () => {
    await withTestHarness(async (harness) => {
      const { request } = await seedCreateTarget(harness);
      installRouteHook(toClaude);
      const info = vi.spyOn(harness.deps.logger, "info");
      await createThreadFromRequest(harness.deps, request);
      expect(JSON.stringify(info.mock.calls)).toContain('"reason_present":true');
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
