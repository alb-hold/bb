import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveThread,
  createEnvironment,
  getHost,
  getThread,
  updateHost,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import type { PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepProviderMachine } from "../../../src/services/machines/provider-orchestration.js";
import { setPluginMachineProviderBridge } from "../../../src/services/plugins/plugin-machine-provider-registry.js";
import { readJson } from "../../helpers/json.js";
import { installMachineProvider } from "../../helpers/machine-provider.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

afterEach(() => {
  vi.restoreAllMocks();
  setPluginMachineProviderBridge(undefined);
});

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function seedDisposableWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), "ephemeral-removal-"));
  const file = join(directory, "work.txt");
  await writeFile(file, "unsaved work");
  return { directory, file };
}

function seedEphemeralMachine(
  harness: TestAppHarness,
  args: { directory: string; archived: boolean },
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = createEnvironment(harness.db, harness.hub, {
    projectId: project.id,
    hostId: host.id,
    path: args.directory,
    providerOwnsPath: false,
    status: "ready",
    environmentProvider: null,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  if (args.archived) archiveThread(harness.db, harness.hub, thread.id);
  updateHost(harness.db, harness.hub, host.id, {
    type: "ephemeral",
    machineProviderId: "test-machine",
    phase: "active",
    resource: { allocation: "ephemeral" },
  });
  return { host, thread };
}

function unarchive(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/unarchive`, {
    method: "POST",
  });
}

describe("an ephemeral machine being removed", () => {
  it("refuses to unarchive an owner while the provider removal is in flight and destroys the machine for the archived owner", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const entered = createDeferredPromise<void>();
        const release = createDeferredPromise<void>();
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            entered.resolve();
            await release.promise;
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: true,
        });

        const sweeping = sweepProviderMachine(harness.deps, host.id);
        await entered.promise;
        const response = await unarchive(harness, thread.id);

        expect(response.status).toBe(409);
        expect(await readJson(response)).toMatchObject({
          code: "machine_removing",
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
        release.resolve();
        await sweeping;

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("keeps refusing to unarchive an owner after a failed removal left the machine waiting to retry", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            if (remove.mock.calls.length === 1)
              return { status: "failed", message: "provider unavailable" };
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: true,
        });

        await sweepProviderMachine(harness.deps, host.id);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
        });
        const response = await unarchive(harness, thread.id);

        expect(response.status).toBe(409);
        expect(await readJson(response)).toMatchObject({
          code: "machine_removing",
        });
        expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
        expect(await exists(file)).toBe(true);

        updateHost(harness.db, harness.hub, host.id, {
          removeRetryAt: Date.now() - 1,
        });
        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).toHaveBeenCalledTimes(2);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)?.phase).toBe("destroyed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));

  it("does not destroy a machine an unarchived idle owner uses, even when the delete is explicit, until the owner is archived", async () =>
    withTestHarness(async (harness) => {
      const { directory, file } = await seedDisposableWorkspace();
      try {
        const remove = vi.fn<PluginMachineProviderDeclaration["remove"]>(
          async () => {
            await rm(directory, { recursive: true });
            return { status: "removed" };
          },
        );
        installMachineProvider({ ephemeral: true, remove });
        const { host, thread } = seedEphemeralMachine(harness, {
          directory,
          archived: false,
        });

        const response = await harness.app.request(`/api/v1/hosts/${host.id}`, {
          method: "DELETE",
        });

        expect(response.status).toBe(200);
        expect(remove).not.toHaveBeenCalled();
        expect(await exists(file)).toBe(true);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "removing",
          teardownStatus: "failed",
          statusMessage: expect.stringContaining(thread.id),
        });
        expect(getHost(harness.db, host.id)?.statusMessage).toContain(
          "archive",
        );

        archiveThread(harness.db, harness.hub, thread.id);
        updateHost(harness.db, harness.hub, host.id, {
          removeRetryAt: Date.now() - 1,
        });
        await sweepProviderMachine(harness.deps, host.id);

        expect(remove).toHaveBeenCalledTimes(1);
        expect(await exists(file)).toBe(false);
        expect(getHost(harness.db, host.id)).toMatchObject({
          phase: "destroyed",
          statusMessage: null,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));
});
