import { createDeferredPromise } from "@bb/test-helpers";
import {
  claimEnvironmentTeardown,
  environmentHookOperations,
  environments,
  getEnvironment,
  getHost,
  getThread,
  releaseEnvironmentTeardownClaim,
  threads,
  updateHost,
} from "@bb/db";
import type { PluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { validatePluginMachineProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepProviderEnvironment } from "../../../src/services/environments/environment-engine.js";
import { toEnvironmentResponse } from "../../../src/services/environments/environment-response.js";
import { sweepProviderMachine } from "../../../src/services/machines/provider-orchestration.js";
import { invokePluginInline } from "../../../src/services/plugins/plugin-hook-registry.js";
import { setPluginEnvironmentProviderBridge } from "../../../src/services/plugins/plugin-environment-provider-registry.js";
import { setPluginMachineProviderBridge } from "../../../src/services/plugins/plugin-machine-provider-registry.js";
import { registerTestHostRpcCapture } from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";

const PLUGIN_ID = "retention";
const PROVIDER_ID = "retention-provider";
const KEPT = "Kept /tmp/retention: has uncommitted changes.";

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
  setPluginMachineProviderBridge(undefined);
});

function installProvider(
  overrides: Partial<PluginEnvironmentProviderDeclaration> = {},
) {
  const record = {
    pluginId: PLUGIN_ID,
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Retention",
      description: "Exercises removal outcomes.",
      icon: "Folder",
      create: async () => {
        throw new Error("Unexpected create");
      },
      remove: async () => ({ status: "removed" }),
      ...overrides,
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return record;
}

function seedRetiring(
  harness: TestAppHarness,
  args: {
    providerOwnsPath?: boolean;
    path?: string | null;
    archivedThread?: boolean;
  } = {},
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host_retention",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/retention-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: args.path === undefined ? "/tmp/retention" : args.path,
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: PLUGIN_ID,
    environmentProviderInstanceKey: "retention-key",
    providerOwnsPath: args.providerOwnsPath ?? false,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  if (args.archivedThread !== false) archive(harness, thread.id);
  return { environment, host, project, session, thread };
}

function archive(harness: TestAppHarness, threadId: string): void {
  harness.db
    .update(threads)
    .set({ archivedAt: Date.now() })
    .where(eq(threads.id, threadId))
    .run();
}

function unarchiveDirectly(harness: TestAppHarness, threadId: string): void {
  harness.db
    .update(threads)
    .set({ archivedAt: null })
    .where(eq(threads.id, threadId))
    .run();
}

function patch(
  harness: TestAppHarness,
  environmentId: string,
  change: Partial<typeof environments.$inferInsert>,
): void {
  harness.db
    .update(environments)
    .set(change)
    .where(eq(environments.id, environmentId))
    .run();
}

function row(harness: TestAppHarness, environmentId: string) {
  const value = getEnvironment(harness.db, environmentId);
  if (value === null) throw new Error("Missing environment");
  return value;
}

function retireNow(harness: TestAppHarness, environmentId: string): void {
  patch(harness, environmentId, { retireAt: Date.now() - 1 });
}

describe("retained environment removal", () => {
  it("restores the earlier state, keeps the message, backs off, and retires again once the provider lets go", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "retained", message: KEPT })
        .mockResolvedValue({ status: "removed" });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment, thread } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
        teardownPriorStatus: null,
      });
      expect(row(harness, environment.id).retireAt).toBeGreaterThan(
        Date.now() + 60_000,
      );
      expect(
        toEnvironmentResponse(harness.db, row(harness, environment.id))
          .lifecycle,
      ).toMatchObject({ phase: "retiring", message: KEPT, teardown: null });

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(remove).toHaveBeenCalledTimes(1);

      unarchiveDirectly(harness, thread.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        retireAt: null,
      });
      expect(
        toEnvironmentResponse(harness.db, row(harness, environment.id))
          .lifecycle.message,
      ).toBeUndefined();

      archive(harness, thread.id);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "removed",
        teardownMessage: null,
        teardownPriorStatus: null,
      });
    }));

  it("keeps an ordinary failure failed with the environment in error", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "failed", message: "rm: busy" }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: "rm: busy",
        teardownPriorStatus: null,
      });
    }));

  it("skips the teardown script and the removal when the preflight retains", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({
        remove,
        experimental_preflightRemove: async () => ({
          status: "retained",
          message: KEPT,
        }),
        policy: { retireGraceMs: 0 },
      });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      const hooks = vi.fn(async () => {});
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: hooks,
      });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(hooks).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(harness.db.select().from(environmentHookOperations).all()).toEqual(
        [],
      );
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
    }));

  it("records a failure instead of a retention once the teardown script has started", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment, host, session } = seedRetiring(harness, {
        providerOwnsPath: true,
      });
      registerTestHostRpcCapture(harness.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {},
      });
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining(
          "teardown script had already started",
        ),
      });
      expect(row(harness, environment.id).teardownMessage).toContain(KEPT);
    }));

  it("lets a later retention restore the error a failed attempt left, never the original ready", async () =>
    withTestHarness(async (harness) => {
      const remove = vi
        .fn<PluginEnvironmentProviderDeclaration["remove"]>()
        .mockResolvedValueOnce({ status: "failed", message: "rm: partial" })
        .mockResolvedValueOnce({ status: "retained", message: KEPT });
      installProvider({ remove, policy: { retireGraceMs: 0 } });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownAttempt: 1,
      });

      retireNow(harness, environment.id);
      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).toHaveBeenCalledTimes(2);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: null,
        teardownMessage: KEPT,
        teardownPriorStatus: null,
      });
    }));

  it("restores ready for an interrupted attempt whose snapshot survived, but fails closed without one", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });
      await sweepProviderEnvironment(harness.deps, environment.id);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });

      const migrated = seedEnvironment(harness.deps, {
        hostId: environment.hostId,
        projectId: environment.projectId,
        path: "/tmp/retention-migrated",
        environmentProviderId: PROVIDER_ID,
        environmentProviderPluginId: PLUGIN_ID,
        environmentProviderInstanceKey: "migrated-key",
      });
      patch(harness, migrated.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: null,
        retireAt: Date.now() - 1,
      });
      await sweepProviderEnvironment(harness.deps, migrated.id);
      expect(row(harness, migrated.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining("unknown"),
      });
    }));

  it("fails instead of restoring ready when a path-less attempt resumed after an interruption", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness, { path: null });
      patch(harness, environment.id, {
        status: "error",
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
        retireAt: Date.now() - 1,
      });

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownStatus: "failed",
        teardownMessage: expect.stringContaining(
          "no record shows which workspaces were already removed",
        ),
      });
    }));

  it("ignores a late result from an attempt that a newer attempt superseded", async () =>
    withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      installProvider({
        remove: async () => {
          entered.resolve();
          await release.promise;
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment } = seedRetiring(harness);
      retireNow(harness, environment.id);

      const sweeping = sweepProviderEnvironment(harness.deps, environment.id);
      await entered.promise;
      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "running",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
      });
      patch(harness, environment.id, { teardownAttempt: 2 });
      release.resolve();
      await sweeping;

      expect(row(harness, environment.id)).toMatchObject({
        teardownStatus: "running",
        teardownAttempt: 2,
      });
    }));

  it("keeps the environment when a thread becomes live between the claim and the removal", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      const state: { revive: () => void } = { revive: () => {} };
      installProvider({
        remove,
        experimental_preflightRemove: async () => {
          state.revive();
          return { status: "removable" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness);
      state.revive = () => unarchiveDirectly(harness, thread.id);
      retireNow(harness, environment.id);

      await sweepProviderEnvironment(harness.deps, environment.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: expect.stringContaining(
          "started using this workspace",
        ),
      });
    }));

  it("refuses to unarchive a thread while its environment is being removed", async () =>
    withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      installProvider({
        remove: async () => {
          entered.resolve();
          await release.promise;
          return { status: "removed" };
        },
        policy: { retireGraceMs: 0 },
      });
      const { environment, thread } = seedRetiring(harness);
      retireNow(harness, environment.id);

      const sweeping = sweepProviderEnvironment(harness.deps, environment.id);
      await entered.promise;
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "workspace_busy",
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      release.resolve();
      await sweeping;
      expect(row(harness, environment.id).teardownStatus).toBe("removed");
    }));

  it("does not claim an environment a live thread uses, and a released claim restores the snapshot", async () =>
    withTestHarness(async (harness) => {
      const { environment, thread } = seedRetiring(harness);
      unarchiveDirectly(harness, thread.id);
      patch(harness, environment.id, {
        teardownStatus: "running",
        retireAt: Date.now(),
      });
      const queued = row(harness, environment.id);

      expect(
        claimEnvironmentTeardown(harness.db, {
          row: queued,
          attempt: 1,
          ignoreLiveThreads: false,
        }),
      ).toBe(false);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: "running",
        teardownAttempt: 0,
      });
      expect(
        claimEnvironmentTeardown(harness.db, {
          row: queued,
          attempt: 1,
          ignoreLiveThreads: true,
        }),
      ).toBe(true);
      expect(row(harness, environment.id)).toMatchObject({
        status: "error",
        teardownAttempt: 1,
        teardownPriorStatus: "ready",
      });
      expect(
        releaseEnvironmentTeardownClaim(harness.db, {
          ...queued,
          teardownAttempt: 1,
        }),
      ).toBe(true);
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownPriorStatus: null,
        retireAt: null,
      });
    }));
});

describe("removal while the machine is being removed", () => {
  function installMachine(): void {
    const machine = {
      pluginId: "cloud",
      provider: validatePluginMachineProviderDeclaration({
        id: "retention-machine",
        displayName: "Retention machine",
        description: "Test machine",
        icon: "Terminal",
        create: async () => {
          throw new Error("Unexpected machine allocation");
        },
        reconcileCleanup: async () => ({ status: "removed" }),
        remove: async () => ({ status: "removed" }),
      }),
    };
    setPluginMachineProviderBridge({
      listMachineProviders: () => [machine],
      getMachineProvider: (id) =>
        id === machine.provider.id ? machine : undefined,
      invokeProvider: async (_pluginId, _label, run) => ({
        ok: true,
        value: await run(),
      }),
      decisionTimeoutMs: 10_000,
    });
  }

  function markRemoving(harness: TestAppHarness, hostId: string): void {
    updateHost(harness.db, harness.hub, hostId, {
      machineProviderId: "retention-machine",
      phase: "removing",
      removeRetryAt: Date.now() - 1,
    });
  }

  it("removes a live-owned environment of an ordinary provider, as before", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({ remove });
      installMachine();
      const { environment, host } = seedRetiring(harness, {
        archivedThread: false,
      });
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(row(harness, environment.id).teardownStatus).toBe("removed");
    }));

  it("keeps a live-owned environment of a provider that respects its owners and names the thread", async () =>
    withTestHarness(async (harness) => {
      const remove = vi.fn<PluginEnvironmentProviderDeclaration["remove"]>(
        async () => ({ status: "removed" }),
      );
      installProvider({
        remove,
        policy: { experimental_respectLiveOwnersOnMachineRemoval: true },
      });
      installMachine();
      const { environment, host, thread } = seedRetiring(harness, {
        archivedThread: false,
      });
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(remove).not.toHaveBeenCalled();
      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
      });
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "removing",
        teardownStatus: "failed",
        statusMessage: expect.stringContaining(thread.id),
      });
    }));

  it("reports a retained environment's own message on the machine", async () =>
    withTestHarness(async (harness) => {
      installProvider({
        remove: async () => ({ status: "retained", message: KEPT }),
      });
      installMachine();
      const { environment, host } = seedRetiring(harness);
      markRemoving(harness, host.id);

      await sweepProviderMachine(harness.deps, host.id);

      expect(row(harness, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
        teardownMessage: KEPT,
      });
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "removing",
        teardownStatus: "failed",
        statusMessage: KEPT,
      });
    }));
});
