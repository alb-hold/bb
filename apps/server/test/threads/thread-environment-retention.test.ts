import {
  environments,
  getEnvironment,
  getThread,
  listOpenEnvironmentRetentionsForHost,
} from "@bb/db";
import type { PluginEnvironmentProviderCreateResult } from "@get-bb/plugin-sdk/environment-provider";
import type { PluginEnvironmentProviderRestoreContext } from "@get-bb/plugin-sdk/environment-provider";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { sweepProviderEnvironment } from "../../src/services/environments/environment-engine.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_ID = "test-retention-worktree";
const KEPT_PATH = "/tmp/kept-attempt";

function registerProvider(
  restore: (
    context: PluginEnvironmentProviderRestoreContext,
  ) => Promise<PluginEnvironmentProviderCreateResult>,
) {
  const record = {
    pluginId: "test",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: PROVIDER_ID,
      displayName: "Worktree",
      description: "Records what a failed create keeps.",
      icon: "Folder",
      policy: { retireGraceMs: 0, pathKeys: "per-attempt" },
      create: async () => {
        throw new Error("Unexpected create");
      },
      restore,
      remove: async () => ({ status: "removed" }),
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_id, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
}

async function destroyedThread(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host_retention_rec" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/worktree",
    environmentProviderId: PROVIDER_ID,
    environmentProviderPluginId: "test",
    providerOwnsPath: true,
    branchName: "bb/important-work",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "prov-1",
    threadId: thread.id,
  });
  expect(
    (
      await harness.app.request(`/api/v1/threads/${thread.id}/archive-all`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  await sweepProviderEnvironment(harness.deps, environment.id);
  expect(
    harness.db
      .select()
      .from(environments)
      .where(eq(environments.id, environment.id))
      .get()?.status,
  ).toBe("destroyed");
  await harness.app.request(`/api/v1/threads/${thread.id}/unarchive`, {
    method: "POST",
  });
  return { environment, host, thread };
}

async function restoreAndWait(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/restore-environment`,
    { method: "POST" },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await expect
    .poll(() => {
      const current = getThread(harness.db, threadId);
      const row = getEnvironment(harness.db, current?.environmentId ?? "");
      return row?.status;
    })
    .toBe("error");
}

afterEach(() => {
  setPluginEnvironmentProviderBridge(undefined);
});

describe("a failed create records what it kept", () => {
  it("records a retained row for the path the provider reports, at the path it claimed", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async (context) => {
        await context.experimental_claimPath(KEPT_PATH);
        return {
          status: "failed",
          message: "setup failed; the workspace stays in place",
          experimental_retained: { path: KEPT_PATH },
        };
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      const rows = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "retained",
        keptPath: KEPT_PATH,
        originalPath: KEPT_PATH,
        providerId: PROVIDER_ID,
        ownerThreadId: thread.id,
      });
    });
  });

  it("leaves an unresolved row when the provider claimed a path and then threw", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async (context) => {
        await context.experimental_claimPath(KEPT_PATH);
        throw new Error("connection lost");
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      const rows = listOpenEnvironmentRetentionsForHost(harness.db, host.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "unresolved", keptPath: KEPT_PATH });
    });
  });

  it("leaves no row when a failed create reports nothing kept", async () => {
    await withTestHarness(async (harness) => {
      registerProvider(async (context) => {
        await context.experimental_claimPath(KEPT_PATH);
        return { status: "failed", message: "git unavailable" };
      });
      const { host, thread } = await destroyedThread(harness);
      await restoreAndWait(harness, thread.id);

      expect(listOpenEnvironmentRetentionsForHost(harness.db, host.id)).toEqual(
        [],
      );
    });
  });
});
