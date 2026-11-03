import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getThread } from "@bb/db";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { toThreadResponseFromThread } from "../../src/services/threads/thread-runtime-display.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const API = "/api/v1";
const WORKSPACE_PATH = "/workspace/account-pool-delete";
const PARENT_TOKEN_ENV = "BB_ACCOUNT_POOL_PARENT_TOKEN";
const RECORD_FILES = [
  "deleted-thread-",
  "archived-thread-",
  "archive-revocation-",
];

afterEach(() => {
  vi.restoreAllMocks();
  setPluginThreadEventEmitter(undefined);
});

function refused(): never {
  throw Object.assign(new Error("EACCES"), { code: "EACCES" });
}

function refuseDeletionRecords(dataDir: string): void {
  const inside = (file: unknown) => String(file).startsWith(dataDir);
  const record = (file: unknown) =>
    inside(file) &&
    RECORD_FILES.some((prefix) =>
      path.basename(String(file)).startsWith(prefix),
    );
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (flags !== undefined && flags !== "r" && record(file)) refused();
    return open(file, flags, mode);
  });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (inside(to) && path.basename(String(to)).startsWith("deleted-pending-"))
      refused();
    return rename(from, to);
  });
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, "mkdir").mockImplementation((async (
    file: Parameters<typeof fs.mkdir>[0],
    options: Parameters<typeof fs.mkdir>[1],
  ) => {
    if (record(file)) refused();
    return mkdir(file, options);
  }) as typeof fs.mkdir);
}

function refuseDeletionRows(kv: PluginKvStorage): void {
  const set = kv.set.bind(kv);
  vi.spyOn(kv, "set").mockImplementation(async (key, value) => {
    if (key.startsWith("deleted-thread:"))
      throw Object.assign(new Error("SQLITE_FULL"), { code: "SQLITE_FULL" });
    return set(key, value);
  });
}

async function deletionRecordFiles(dataDir: string): Promise<string[]> {
  return (await fs.readdir(dataDir, { recursive: true }))
    .map((name) => path.basename(name))
    .filter(
      (name) =>
        name.startsWith("deleted-thread-") ||
        name.startsWith("deleted-pending-"),
    );
}

function seedPooledThread(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-pool-delete" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
  });
  return { host, thread };
}

describe("Account Pooler after bb's real delete route", () => {
  it("refuses the env export and both token paths after a restart when bb committed the delete and the plugin's kv row and every filesystem deletion record were refused", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedPooledThread(harness);
      const poolModule = await import(
        new URL(
          "../../../../plugins/account-pool/src/server.ts",
          import.meta.url,
        ).href
      );
      const createAccountPoolPlugin: (options: {
        now: () => number;
        env: NodeJS.ProcessEnv;
        fetch: typeof fetch;
      }) => (bb: BbPluginApi) => Promise<void> =
        poolModule.createAccountPoolPlugin;
      const plugin = createAccountPoolPlugin({
        now: Date.now,
        env: {},
        fetch: async () => Response.json({}, { status: 200 }),
      });
      const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-delete-"));
      const lookups: string[] = [];
      let pool = createFakePluginHost({
        pluginId: "account-pool",
        dataDir,
        sdk: {
          hosts: { list: async () => [host] },
          system: { providerStates: async () => ({ providers: [] }) },
          threads: {
            get: async ({ threadId }: { threadId: string }) => {
              lookups.push(threadId);
              const row = getThread(harness.db, threadId);
              if (row === null)
                throw Object.assign(new Error("thread not found"), {
                  status: 404,
                  code: "thread_not_found",
                });
              return row;
            },
          },
          plugins: {
            list: async () => ({
              plugins: [{ id: "account-pool", enabled: true }],
            }),
          },
        },
      });
      const deliveries: Promise<{ errors: unknown[] }>[] = [];
      const ignore = () => {};
      setPluginThreadEventEmitter({
        emitThreadEvents: ignore,
        emitTerminalInput: ignore,
        emitHostDeleted: ignore,
        emitEnvironmentRemoved: ignore,
        emitThreadCreated: ignore,
        emitThreadActive: ignore,
        emitThreadIdle: ignore,
        emitThreadFailed: ignore,
        emitThreadArchived: ignore,
        emitThreadDeleted: (deleted) => {
          deliveries.push(
            pool.harness.behavior.emitThreadEvent("thread.deleted", {
              thread: toThreadResponseFromThread(
                {
                  db: harness.db,
                  hub: harness.deps.hub,
                  providerRegistry: harness.deps.providerRegistry,
                },
                { thread: deleted },
              ),
            }),
          );
        },
        emitInteractionPending: ignore,
        emitMessageQueued: ignore,
        emitMessageDispatched: ignore,
        emitMessageCancelled: ignore,
        emitThreadUnarchived: ignore,
        emitThreadParentChanged: ignore,
        emitTurnFailed: ignore,
      });
      const context = {
        threadId: thread.id,
        projectId: thread.projectId,
        hostId: host.id,
      };
      const threadTokenAccepted = async (token: string) =>
        (
          await pool.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ model: "claude-opus-4-1", messages: [] }),
          })
        ).status !== 401;
      const nestedTokenAccepted = async (token: string) =>
        (
          await pool.harness.behavior.fetchHttp("GET", "/availability", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status !== 401;
      try {
        await plugin(pool.bb);
        await pool.harness.behavior.callRpc("account.add", {
          provider: "claude",
          source: { kind: "api-key", apiKey: "test-account" },
          label: null,
          priority: 1,
        });
        pool.harness.behavior.runService("hub");
        const entries = await pool.harness.behavior.resolveProviderEnv(
          "claude-code",
          context,
        );
        const token = entries.find(
          (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
        )?.value;
        const nested = entries.find(
          (entry) => entry.name === PARENT_TOKEN_ENV,
        )?.value;
        if (typeof token !== "string" || typeof nested !== "string")
          throw new Error("Expected a pool token and a nested token");
        expect(await threadTokenAccepted(token)).toBe(true);
        expect(await nestedTokenAccepted(nested)).toBe(true);

        refuseDeletionRecords(dataDir);
        refuseDeletionRows(pool.bb.storage.kv);
        const deleted = await harness.app.request(
          `${API}/threads/${thread.id}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ childThreadsConfirmed: false }),
          },
        );
        expect(deleted.status).toBe(200);
        expect(getThread(harness.db, thread.id)?.deletedAt ?? null).not.toBe(
          null,
        );
        expect(deliveries).toHaveLength(1);
        const [delivery] = await Promise.all(deliveries);
        expect(String(delivery?.errors[0])).toContain(
          "could not record the deletion",
        );
        expect(await pool.bb.storage.kv.list("deleted-thread:")).toEqual([]);
        expect(await deletionRecordFiles(dataDir)).toEqual([]);

        pool = await pool.harness.lifecycle.reload(async (bb) => {
          refuseDeletionRows(bb.storage.kv);
          await plugin(bb);
        });
        lookups.length = 0;
        const after = await pool.harness.behavior.resolveProviderEnv(
          "claude-code",
          context,
        );
        expect(
          after.filter(
            (entry) =>
              entry.name === "ANTHROPIC_AUTH_TOKEN" ||
              entry.name === PARENT_TOKEN_ENV,
          ),
        ).toEqual([]);
        expect(await threadTokenAccepted(token)).toBe(false);
        expect(await nestedTokenAccepted(nested)).toBe(false);
        expect(lookups.length).toBeGreaterThan(0);
        expect(lookups.every((threadId) => threadId === thread.id)).toBe(true);
        expect(getThread(harness.db, thread.id)?.deletedAt ?? null).not.toBe(
          null,
        );
        expect(await pool.bb.storage.kv.list("deleted-thread:")).toEqual([]);
        expect(await deletionRecordFiles(dataDir)).toEqual([]);
      } finally {
        await pool.harness.lifecycle.dispose();
        vi.restoreAllMocks();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  });
});
