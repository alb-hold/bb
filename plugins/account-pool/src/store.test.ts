import { createAccountPoolTestHost } from "./test-host.js";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import Database from "better-sqlite3";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "./contracts.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function delayedAccountReads(kv: PluginKvStorage): PluginKvStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await kv.get<T>(key);
      if (key === "accounts:v1") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return value;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: (prefix) => kv.list(prefix),
  };
}

describe("AccountStore", () => {
  it("loads account metadata written before account UUIDs were stored", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
    const store = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await host.bb.storage.kv.set("accounts:v1", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "claude",
        kind: "oauth",
        label: "existing",
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
        createdAt: 1,
      },
    ]);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountUuid: null }),
    ]);
  });

  it("preserves both accounts added concurrently", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
    const secretsDir = path.join(dataDir, "secrets");
    const store = new AccountStore(
      delayedAccountReads(host.bb.storage.kv),
      secretsDir,
    );
    await store.initialize();
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const account = (
      label: string,
    ): Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"> => ({
      provider: "claude",
      kind: "api-key",
      label,
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    });

    const [first, second] = await Promise.all([
      store.add(account("first"), { kind: "api-key", apiKey: "sk-first" }),
      store.add(account("second"), { kind: "api-key", apiKey: "sk-second" }),
    ]);

    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("forgets a removed account's organization and keeps the others", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
    const store = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await store.initialize();
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const add = (label: string) =>
      store.add(
        {
          provider: "claude",
          kind: "oauth",
          label,
          email: `${label}@example.com`,
          accountUuid: null,
          subscriptionType: null,
          rateLimitTier: null,
          enabled: true,
          priority: 1,
        },
        {
          kind: "oauth",
          accessToken: `${label}-access`,
          refreshToken: `${label}-refresh`,
          expiresAt: null,
        },
      );
    const removed = await add("removed");
    const kept = await add("kept");
    await store.setOrganization(
      removed.id,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    await store.setOrganization(
      kept.id,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );

    expect(await store.remove(removed.id)).toBe(true);

    expect(await host.bb.storage.kv.get("organizations:v1")).toEqual({
      [kept.id]: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });

  it("checks a turn-off selector against a write that held the store when it was called, and a refusal writes nothing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const kv = host.bb.storage.kv;
    const writes: string[] = [];
    let holdNextAccountsWrite = false;
    let held = () => {};
    let release = () => {};
    const writeHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new AccountStore(
      {
        get: (key) => kv.get(key),
        async set(key, value) {
          writes.push(`set ${key}`);
          if (key === "accounts:v1" && holdNextAccountsWrite) {
            holdNextAccountsWrite = false;
            held();
            await barrier;
          }
          await kv.set(key, value);
        },
        async delete(key) {
          writes.push(`delete ${key}`);
          await kv.delete(key);
        },
        list: (prefix) => kv.list(prefix),
      },
      path.join(dataDir, "secrets"),
    );
    await store.initialize();
    const add = (label: string) =>
      store.add(
        {
          provider: "claude",
          kind: "oauth",
          label,
          email: "shared@example.com",
          accountUuid: null,
          subscriptionType: null,
          rateLimitTier: null,
          enabled: true,
          priority: 1,
        },
        {
          kind: "oauth",
          accessToken: `${label}-access`,
          refreshToken: `${label}-refresh`,
          expiresAt: null,
        },
      );
    const principal = await add("principal");
    const twin = await add("twin");
    writes.length = 0;
    type Locked = {
      mutationLock: Promise<void> | null;
      serialized(action: () => Promise<unknown>): Promise<unknown>;
    };
    const lock = AccountStore.prototype as unknown as Locked;
    const serialized = lock.serialized;
    let holding: Promise<void> | null = null;
    const queue = vi.spyOn(lock, "serialized").mockImplementation(function (
      this: Locked,
      action: () => Promise<unknown>,
    ) {
      const before = this.mutationLock;
      const pending = serialized.call(this, action);
      const registered =
        this.mutationLock !== null && this.mutationLock !== before;
      writes.push(
        !registered
          ? "lock not registered"
          : before === null
            ? "lock taken"
            : before === holding
              ? "queued behind held write"
              : "queued behind another call",
      );
      return pending;
    });
    cleanups.push(async () => queue.mockRestore());

    holdNextAccountsWrite = true;
    const concurrent = store.setEnabled(twin.id, false);
    await writeHeld;
    expect(writes).toEqual(["lock taken", "set accounts:v1"]);
    holding = (store as unknown as Locked).mutationLock;
    expect(holding).not.toBeNull();
    const seen: Array<Array<{ id: string; enabled: boolean }>> = [];
    const turnOff = store
      .disableWhere((accounts) => {
        seen.push(accounts.map(({ id, enabled }) => ({ id, enabled })));
        if (accounts.some(({ enabled }) => !enabled)) {
          throw new Error("changed");
        }
        return [principal.id, twin.id];
      })
      .then(
        () => "turned off",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    let turnOffSettled = false;
    void turnOff.then(() => {
      turnOffSettled = true;
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(seen).toEqual([]);
    expect(turnOffSettled).toBe(false);
    expect(writes).toEqual([
      "lock taken",
      "set accounts:v1",
      "queued behind held write",
    ]);

    release();
    await concurrent;
    expect(await turnOff).toBe("changed");
    expect(seen).toEqual([
      [
        { id: principal.id, enabled: true },
        { id: twin.id, enabled: false },
      ],
    ]);
    expect(writes).toEqual([
      "lock taken",
      "set accounts:v1",
      "queued behind held write",
    ]);
    expect(
      (await store.list()).map(({ id, enabled }) => ({ id, enabled })),
    ).toEqual([
      { id: principal.id, enabled: true },
      { id: twin.id, enabled: false },
    ]);
  });

  describe("a failed write across the Claude/Codex and Gemini keys", () => {
    async function failingStore() {
      const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
      const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
      cleanups.push(async () => {
        await host.harness.lifecycle.dispose();
        await fs.rm(dataDir, { recursive: true, force: true });
      });
      const kv = host.bb.storage.kv;
      const failing = new Set<string>();
      const secrets = path.join(dataDir, "secrets");
      const store = new AccountStore(
        {
          get: (key) => kv.get(key),
          async set(key, value) {
            if (failing.has(key)) throw new Error(`write ${key} failed`);
            await kv.set(key, value);
          },
          delete: (key) => kv.delete(key),
          list: (prefix) => kv.list(prefix),
        },
        secrets,
      );
      await store.initialize();
      const reload = async () => {
        const fresh = new AccountStore(kv, secrets);
        return (await fresh.list()).map(({ id, provider, enabled }) => ({
          id,
          provider,
          enabled,
        }));
      };
      return { store, failing, secrets, reload };
    }
    const input = (provider: "claude" | "gemini", label: string) =>
      ({
        provider,
        kind: "oauth",
        label,
        email: null,
        accountUuid: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 1,
      }) as const;
    const secret = {
      kind: "oauth",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: null,
    } as const;

    it("leaves no Gemini row or secret when the Gemini write fails on add", async () => {
      const { store, failing, secrets, reload } = await failingStore();
      const claude = await store.add(input("claude", "c"), secret);
      failing.add("accounts:gemini:v1");
      await expect(store.add(input("gemini", "g"), secret)).rejects.toThrow(
        "write accounts:gemini:v1 failed",
      );
      expect(await reload()).toEqual([
        { id: claude.id, provider: "claude", enabled: true },
      ]);
      expect(await store.list()).toHaveLength(1);
      expect((await fs.readdir(secrets)).length).toBe(1);
    });

    it("adds a Gemini account without rewriting the Claude/Codex key", async () => {
      const { store, failing, reload } = await failingStore();
      const claude = await store.add(input("claude", "c"), secret);
      failing.add("accounts:v1");
      const gemini = await store.add(input("gemini", "g"), secret);
      expect(await reload()).toEqual([
        { id: claude.id, provider: "claude", enabled: true },
        { id: gemini.id, provider: "gemini", enabled: true },
      ]);
    });

    it.each([
      ["accounts:gemini:v1", [true, true]],
      ["accounts:v1", [true, false]],
    ] as const)(
      "writes each half on its own, Gemini first, when %s fails in a write that changes both",
      async (key, enabled) => {
        const { store, failing, reload } = await failingStore();
        const claude = await store.add(input("claude", "c"), secret);
        const gemini = await store.add(input("gemini", "g"), secret);
        failing.add(key);
        await expect(
          store.disableWhere(() => [claude.id, gemini.id]),
        ).rejects.toThrow(`write ${key} failed`);
        const after = [
          { id: claude.id, provider: "claude", enabled: enabled[0] },
          { id: gemini.id, provider: "gemini", enabled: enabled[1] },
        ];
        expect(await reload()).toEqual(after);
        expect(
          (await store.list()).map(({ id, provider, enabled }) => ({
            id,
            provider,
            enabled,
          })),
        ).toEqual(after);
        failing.clear();
        expect(
          (await store.disableWhere(() => [claude.id, gemini.id]))?.length,
        ).toBe(enabled.filter(Boolean).length);
        expect((await reload()).map(({ enabled }) => enabled)).toEqual([
          false,
          false,
        ]);
      },
    );
  });
});

describe("QuotaStore", () => {
  it("adds model quota storage to a migrated database copy without changing pre-change rows", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "pool-model-migration-"));
    const host = createAccountPoolTestHost({ pluginId: "account-pool", dataDir });
    const database = new Database(":memory:");
    host.bb.storage.migrate(database, QUOTA_MIGRATIONS.slice(0, -1));
    const accountId = "11111111-1111-4111-8111-111111111111";
    database
      .prepare(
        "INSERT INTO account_quota (account_id, seven_day_utilization) VALUES (?, ?)",
      )
      .run(accountId, 0.5);
    const before = new QuotaStore(database).get(accountId);
    const copy = new Database(database.serialize());
    try {
      host.bb.storage.migrate(copy, QUOTA_MIGRATIONS);
      host.bb.storage.migrate(copy, QUOTA_MIGRATIONS);
      const store = new QuotaStore(copy);
      expect(store.get(accountId)).toEqual(before);
      expect(store.modelWeekly(accountId)).toBeUndefined();
      const quota = {
        utilization: 0.25,
        resetAt: null,
        status: "allowed",
        observedAt: 1,
        source: "usage" as const,
      };
      store.putModelWeekly(accountId, { "Claude Future 42": quota });
      expect(new QuotaStore(copy).modelWeekly(accountId)).toEqual({
        "Claude Future 42": quota,
      });
      expect(store.get(accountId)).toEqual(before);
      store.putModelWeekly(accountId, {});
      expect(store.modelWeekly(accountId)).toEqual({});
    } finally {
      copy.close();
      database.close();
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates an existing quota table to family observations", () => {
    const database = new Database(":memory:");
    const initial = QUOTA_MIGRATIONS[0];
    const familyMigration = QUOTA_MIGRATIONS[1];
    const windowMigration = QUOTA_MIGRATIONS[2];
    if (
      initial === undefined ||
      familyMigration === undefined ||
      windowMigration === undefined
    ) {
      throw new Error("Expected quota migrations.");
    }
    database.exec(initial);
    database
      .prepare(
        `INSERT INTO account_quota (
          account_id, seven_day_utilization, bucket_exhaustion_json
        ) VALUES (?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        0.5,
        '{"7d_oi":4102452000000}',
      );
    database.exec(familyMigration);
    database.exec(windowMigration);
    for (const migration of QUOTA_MIGRATIONS.slice(3)) database.exec(migration);
    const quotas = new QuotaStore(database);

    const migrated = quotas.get("11111111-1111-4111-8111-111111111111");
    expect(migrated.limitWindows).toEqual([
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.5,
        resetAt: null,
        status: null,
        observedAt: 0,
        source: "header",
      },
    ]);
    expect(migrated.extraUsage).toBeNull();
    expect(migrated.familyWeekly).toEqual({
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    });
    quotas.put({
      ...migrated,
      familyWeekly: {
        ...migrated.familyWeekly,
        fable: {
          utilization: 1,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: 10,
          source: "usage",
        },
      },
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").familyWeekly.fable,
    ).toMatchObject({ utilization: 1, source: "usage" });
    quotas.put({
      ...migrated,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          resetAt: 4_102_452_000_000,
          status: "allowed",
          observedAt: 10,
          source: "usage",
        },
      ],
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").limitWindows,
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: 4_102_452_000_000,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    database.close();
  });

  it("moves stored Claude five-hour and seven-day columns into limit windows", () => {
    const database = new Database(":memory:");
    const moveMigration = QUOTA_MIGRATIONS.length - 1;
    for (const migration of QUOTA_MIGRATIONS.slice(0, moveMigration))
      database.exec(migration);
    const claudeId = "11111111-1111-4111-8111-111111111111";
    const codexId = "22222222-2222-4222-8222-222222222222";
    const codexWindows = JSON.stringify([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: null,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    const insert = database.prepare(
      `INSERT INTO account_quota (
        account_id, five_hour_utilization, five_hour_reset_at, five_hour_status,
        seven_day_utilization, seven_day_reset_at, seven_day_status,
        limit_windows_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      claudeId,
      1,
      4_102_444_800_000,
      "rejected",
      0.25,
      4_102_448_400_000,
      "allowed",
      "[]",
      50,
    );
    insert.run(codexId, null, null, null, null, null, null, codexWindows, 60);
    database.exec(QUOTA_MIGRATIONS[moveMigration] ?? "");
    const quotas = new QuotaStore(database);

    expect(quotas.get(claudeId).limitWindows).toEqual([
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 1,
        resetAt: 4_102_444_800_000,
        status: "rejected",
        observedAt: 50,
        source: "header",
      },
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.25,
        resetAt: 4_102_448_400_000,
        status: "allowed",
        observedAt: 50,
        source: "header",
      },
    ]);
    expect(quotas.get(codexId).limitWindows).toEqual(JSON.parse(codexWindows));
    expect(
      database
        .prepare(
          `SELECT count(*) AS stale FROM account_quota
           WHERE five_hour_utilization IS NOT NULL OR five_hour_status IS NOT NULL
             OR seven_day_utilization IS NOT NULL OR seven_day_status IS NOT NULL`,
        )
        .get(),
    ).toEqual({ stale: 0 });
    database.close();
  });

  it("reads and writes quotas when a newer build has added a column", () => {
    const database = new Database(":memory:");
    for (const migration of QUOTA_MIGRATIONS) database.exec(migration);
    database.exec(
      "ALTER TABLE account_quota ADD COLUMN later_json TEXT NOT NULL DEFAULT '{}'",
    );
    const quotas = new QuotaStore(database);
    const accountId = "11111111-1111-4111-8111-111111111111";

    quotas.put({ ...quotas.get(accountId), representativeClaim: "five_hour" });

    expect(quotas.get(accountId).representativeClaim).toBe("five_hour");
    database.close();
  });
});
