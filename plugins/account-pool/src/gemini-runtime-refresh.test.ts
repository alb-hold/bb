import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPoolConfigSchema } from "./contracts.js";
import { createHub, type AccountPoolHub } from "./hub.js";
import { PoolOperations } from "./operations.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const MINUTE = 60_000;
const UPSTREAM = "https://code-assist.invalid";
const RUNTIME_UA =
  "antigravity/acp/1.5.0 (aidev_client; os_type=darwin; arch=arm64)";
const AUTH_ERROR = "OAuth refresh failed with HTTP 400. invalid_grant.";
const LOOKUP_ERROR = "provider-acp settings are not loaded yet";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.useRealTimers();
});

const START = 1_800_000_000_000;

function useFakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
    now: START,
  });
  return () => Date.now();
}

async function createGeminiPool(
  failedLookups: number,
  storedError: string | null = null,
  clock: { now?: () => number; lookupFails?: () => boolean } = {},
) {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "bb-account-pool-gemini-runtime-"),
  );
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.bb.storage.database();
  host.bb.storage.migrate(database, QUOTA_MIGRATIONS);
  const secretsDir = path.join(dataDir, "secrets");
  let time = 1_800_000_000_000;
  const now = clock.now ?? (() => time);
  const hubTokens = new HubTokenStore(secretsDir, now);
  const accounts = new AccountStore(host.bb.storage.kv, secretsDir);
  const quotas = new QuotaStore(database);
  await accounts.initialize();
  await hubTokens.initialize();
  const threadTokens = new ThreadTokenStore(secretsDir, hubTokens, now);
  await threadTokens.initialize(["synthetic-host"]);
  const account = await accounts.add(
    {
      provider: "gemini",
      kind: "oauth",
      label: "synthetic-gemini",
      email: null,
      accountUuid: null,
      geminiProject: "synthetic-project",
      geminiEndpoint: "daily",
      subscriptionType: "Google AI Ultra",
      rateLimitTier: null,
      enabled: true,
      priority: 0,
    },
    {
      kind: "oauth",
      accessToken: "access-synthetic",
      refreshToken: "refresh-synthetic",
      expiresAt: now() + 24 * 60 * MINUTE,
    },
  );
  if (storedError !== null)
    quotas.put({ ...quotas.get(account.id), error: storedError });
  let lookups = 0;
  let remainingFailures = failedLookups;
  const lookupTimes: number[] = [];
  const runtimeUserAgent = async () => {
    lookups += 1;
    lookupTimes.push(now());
    if (clock.lookupFails?.() === true) throw new Error(LOOKUP_ERROR);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error(LOOKUP_ERROR);
    }
    return RUNTIME_UA;
  };
  const calls: string[] = [];
  let quotaMode: "normal" | "http" | "unreadable" | "missing" | "empty" | "unknown" | "empty-daily-http-prod" | "a-mixed-b-empty" = "normal";
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1internal:loadCodeAssist"))
      return Response.json({
        cloudaicompanionProject:
          quotaMode === "a-mixed-b-empty"
            ? url.includes("/daily/")
              ? "proj-own"
              : "proj-other"
            : "synthetic-project",
        paidTier: { name: "Google AI Ultra" },
      });
    if (url.endsWith("/v1internal:retrieveUserQuotaSummary")) {
      if (quotaMode === "a-mixed-b-empty") {
        const project: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body).project : undefined;
        return project === "proj-own" && url.includes("/prod/")
          ? Response.json({ error: "synthetic failure" }, { status: 503 })
          : Response.json({ buckets: [] });
      }
      if (quotaMode === "empty-daily-http-prod")
        return url.includes("/daily/")
          ? Response.json({ buckets: [] })
          : Response.json({ error: "synthetic failure" }, { status: 503 });
      if (quotaMode === "http")
        return Response.json({ error: "synthetic failure" }, { status: 503 });
      if (quotaMode === "unreadable")
        return Response.json({ unexpected: true });
      if (quotaMode === "missing") return Response.json({});
      if (quotaMode === "empty") return Response.json({ buckets: [] });
      if (quotaMode === "unknown")
        return Response.json({
          buckets: [{ bucketId: "future-model", remainingFraction: 0.2 }],
        });
      return Response.json({
        buckets: [
          {
            bucketId: "gemini-4-neon",
            remainingFraction: 0.75,
            resetTime: "2100-01-01T00:00:00Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected network destination ${url}.`);
  };
  const hub: AccountPoolHub = createHub({
    accounts,
    quotas,
    affinity: new PoolAffinityStore(database),
    hubTokens,
    threadTokens,
    now,
    fetch: transport,
    getSettings: () =>
      accountPoolConfigSchema.parse({
        anthropicUpstreamBaseUrl: UPSTREAM,
        codexUpstreamBaseUrl: UPSTREAM,
      }),
    refreshUrl: `${UPSTREAM}/token`,
    codexRefreshUrl: `${UPSTREAM}/token`,
    usageUrl: `${UPSTREAM}/usage`,
    codexUsageUrl: `${UPSTREAM}/usage`,
    geminiRefreshUrl: `${UPSTREAM}/token`,
    geminiUpstreamBaseUrls: {
      prod: `${UPSTREAM}/prod`,
      daily: `${UPSTREAM}/daily`,
    },
    geminiRuntimeUserAgent: runtimeUserAgent,
    onAccountsChanged: () => {},
  });
  const controller = new AbortController();
  const running = hub.start(controller.signal);
  const operations = new PoolOperations(
    accounts,
    quotas,
    hub,
    hubTokens,
    new RoutingStore(host.bb.storage.kv, now),
    async () => [],
    async () => [],
    now,
  );
  cleanups.push(async () => {
    controller.abort();
    await running;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const summary = async () => {
    const status = await hub.status();
    const found = status.accounts.find((entry) => entry.id === account.id);
    if (found === undefined) throw new Error("Account missing from status.");
    return found;
  };
  return {
    account,
    accounts,
    hub,
    operations,
    quotas,
    calls,
    lookups: () => lookups,
    lookupTimes,
    settled: () => hub.refreshUsage(),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    now,
    setQuotaMode: (mode: typeof quotaMode) => {
      quotaMode = mode;
    },
    summary,
    eligible: async () =>
      (await hub.nextAccountPreview("gemini")).nextAccountId === account.id,
  };
}

function setStaleUsage(pool: Awaited<ReturnType<typeof createGeminiPool>>) {
  const observedAt = pool.now() - 64 * MINUTE;
  pool.quotas.put({
    ...pool.quotas.get(pool.account.id),
    limitWindows: [
      {
        slot: "primary",
        windowMinutes: null,
        utilization: 0.54,
        resetAt: null,
        status: "allowed",
        observedAt,
        source: "usage",
      },
    ],
    observedAt,
  });
  return observedAt;
}

describe("Gemini usage refresh after a failed antigravity-acp runtime lookup", () => {
  it("clears the runtime error on the next scheduled refresh and makes the account eligible again", async () => {
    const pool = await createGeminiPool(1);
    await vi.waitFor(async () => {
      expect((await pool.summary()).error).toBe(
        `Gemini usage refresh stopped (runtime_version): ${LOOKUP_ERROR}`,
      );
    });
    expect((await pool.summary()).status).toBe("error");
    expect(await pool.eligible()).toBe(false);

    pool.advance(5 * MINUTE + 1_000);
    await pool.hub.refreshUsage();

    const recovered = await pool.summary();
    expect(recovered.error).toBeNull();
    expect(recovered.status).toBe("ready");
    expect(recovered.observedAt).toBe(pool.now());
    expect(recovered.limitWindows[0]?.utilization).toBeCloseTo(0.25);
    expect(await pool.eligible()).toBe(true);
    expect(pool.lookups()).toBe(2);
    const quota = pool.calls.filter((url) =>
      url.endsWith(":retrieveUserQuotaSummary"),
    );
    expect(quota.filter((url) => url.includes("/daily/"))).toHaveLength(1);
    expect(quota.filter((url) => url.includes("/prod/"))).toHaveLength(1);
  });

  it("retries a failed startup lookup within seconds, not on the five-minute cadence", async () => {
    const now = useFakeClock();
    const pool = await createGeminiPool(0, null, {
      now,
      lookupFails: () => now() < START + 20_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => {
      expect((await pool.summary()).error).toBe(
        `Gemini usage refresh stopped (runtime_version): ${LOOKUP_ERROR}`,
      );
    });
    expect(await pool.eligible()).toBe(false);

    await vi.advanceTimersByTimeAsync(50_000);
    await pool.settled();

    const recovered = await pool.summary();
    expect(recovered.error).toBeNull();
    expect(recovered.status).toBe("ready");
    expect(await pool.eligible()).toBe(true);
    expect(pool.lookupTimes.map((at) => at - START)).toEqual([
      0, 15_000, 45_000,
    ]);
  });

  it("backs off to the five-minute cadence while the lookup keeps failing", async () => {
    const now = useFakeClock();
    const pool = await createGeminiPool(0, null, {
      now,
      lookupFails: () => true,
    });
    for (let elapsed = 0; elapsed < 40 * MINUTE; elapsed += 5_000)
      await vi.advanceTimersByTimeAsync(5_000);

    const gaps = pool.lookupTimes
      .slice(1)
      .map((at, index) => at - (pool.lookupTimes[index] ?? at));
    expect(gaps.slice(0, 5)).toEqual([
      15_000,
      30_000,
      60_000,
      120_000,
      5 * MINUTE,
    ]);
    expect(gaps.every((gap) => gap >= 15_000 && gap <= 5 * MINUTE)).toBe(true);
    expect(gaps.slice(4).every((gap) => gap === 5 * MINUTE)).toBe(true);
    expect((await pool.summary()).status).toBe("error");
  });

  it("does not fast-retry a real auth failure", async () => {
    const now = useFakeClock();
    const pool = await createGeminiPool(0, AUTH_ERROR, {
      now,
      lookupFails: () => true,
    });
    for (let elapsed = 0; elapsed < 6 * MINUTE; elapsed += 5_000)
      await vi.advanceTimersByTimeAsync(5_000);

    expect(pool.lookupTimes.map((at) => at - START)).toEqual([0, 5 * MINUTE]);
    expect((await pool.summary()).error).toBe(AUTH_ERROR);
  });

  it("keeps a real auth failure in error when the runtime lookup works", async () => {
    const pool = await createGeminiPool(0, AUTH_ERROR);
    await vi.waitFor(() => {
      expect(pool.lookups()).toBe(1);
    });
    await pool.settled();
    expect((await pool.summary()).error).toBe(AUTH_ERROR);

    pool.advance(5 * MINUTE + 1_000);
    await pool.hub.refreshUsage();

    const summary = await pool.summary();
    expect(summary.error).toBe(AUTH_ERROR);
    expect(summary.status).toBe("error");
    expect(await pool.eligible()).toBe(false);
  });

  it("keeps a real auth failure when the runtime lookup fails and later recovers", async () => {
    const pool = await createGeminiPool(1, AUTH_ERROR);
    await vi.waitFor(() => {
      expect(pool.lookups()).toBe(1);
    });
    await pool.settled();
    expect((await pool.summary()).error).toBe(AUTH_ERROR);

    pool.advance(5 * MINUTE + 1_000);
    await pool.hub.refreshUsage();

    const summary = await pool.summary();
    expect(summary.error).toBe(AUTH_ERROR);
    expect(summary.status).toBe("error");
    expect(await pool.eligible()).toBe(false);
  });
});

describe("Gemini usage refresh results", () => {
  it("rejects a forced refresh for a non-OAuth account instead of reporting an unchanged reading as refreshed", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const account = await pool.accounts.add(
      {
        provider: "gemini",
        kind: "api-key",
        label: "synthetic-gemini-key",
        email: null,
        accountUuid: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 1,
      },
      { kind: "api-key", apiKey: "synthetic-api-key" },
    );

    await expect(pool.operations.refreshUsage(account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
  });

  it("rejects a forced refresh when its stored credential cannot answer and preserves the old reading", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const observedAt = setStaleUsage(pool);
    await pool.accounts.writeSecret(pool.account.id, {
      kind: "api-key",
      apiKey: "synthetic-api-key",
    });

    await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
    expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(
      0.54,
    );
  });

  it("reports one endpoint empty and the other failed as a failed refresh that leaves the account's eligibility unchanged", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const observedAt = setStaleUsage(pool);
    const eligibleBefore = await pool.eligible();
    pool.setQuotaMode("empty-daily-http-prod");

    await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
    expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(0.54);
    expect(await pool.eligible()).toBe(eligibleBefore);
  });

  it("reports an empty read from a later candidate after a mixed failure on an earlier one as a failed refresh that leaves eligibility unchanged", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const observedAt = setStaleUsage(pool);
    const eligibleBefore = await pool.eligible();
    pool.setQuotaMode("a-mixed-b-empty");

    await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
    expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(0.54);
    expect(await pool.eligible()).toBe(eligibleBefore);
  });

  it.each(["http", "unreadable", "missing", "unknown"] as const)(
    "reports a %s Gemini quota response as a failed refresh without replacing the cached reading",
    async (mode) => {
      const pool = await createGeminiPool(0);
      await pool.settled();
      const observedAt = setStaleUsage(pool);
      pool.setQuotaMode(mode);

      await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
        "Could not refresh account usage. Try again.",
      );
      expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
      expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(
        0.54,
      );
    },
  );

  it("stamps a fresh daily quota reading on a forced refresh", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const oldObservedAt = setStaleUsage(pool);

    const account = await pool.operations.refreshUsage(pool.account.id);

    expect(account?.observedAt).toBe(pool.now());
    expect(account?.observedAt).not.toBe(oldObservedAt);
    expect(account?.limitWindows).toHaveLength(1);
    expect(account?.limitWindows[0]).toMatchObject({
      slot: "primary",
      utilization: 0.25,
      observedAt: pool.now(),
    });
  });

  it("stamps an empty parsed reading for a forced empty quota response", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const oldObservedAt = setStaleUsage(pool);
    pool.setQuotaMode("empty");

    const account = await pool.operations.refreshUsage(pool.account.id);

    expect(account?.observedAt).toBe(pool.now());
    expect(account?.observedAt).not.toBe(oldObservedAt);
    expect(account?.limitWindows).toEqual([]);
    expect(account?.usageRestriction).toBeNull();
    expect(await pool.eligible()).toBe(true);
    expect((await pool.summary()).limitWindows).toEqual([]);
  });
});

describe("scheduled Gemini usage refresh", () => {
  it("stamps a fresh daily quota reading after the refresh interval", async () => {
    const now = useFakeClock();
    const pool = await createGeminiPool(0, null, { now });
    await vi.advanceTimersByTimeAsync(0);
    await pool.settled();
    const oldObservedAt = setStaleUsage(pool);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await pool.settled();

    expect(pool.quotas.get(pool.account.id).observedAt).toBe(pool.now());
    expect(pool.quotas.get(pool.account.id).observedAt).not.toBe(oldObservedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]).toMatchObject({
      slot: "primary",
      utilization: 0.25,
      observedAt: pool.now(),
    });
  });

  it.each([
    ["missing", false],
    ["empty", true],
    ["unknown", false],
  ] as const)(
    "handles a scheduled %s quota response as expected",
    async (mode, succeeds) => {
      const now = useFakeClock();
      const pool = await createGeminiPool(0, null, { now });
      await vi.advanceTimersByTimeAsync(0);
      await pool.settled();
      const oldObservedAt = setStaleUsage(pool);
      pool.setQuotaMode(mode);

      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      await pool.settled();

      const reading = pool.quotas.get(pool.account.id);
      expect(reading.observedAt).toBe(succeeds ? pool.now() : oldObservedAt);
      expect(reading.limitWindows).toEqual(
        succeeds
          ? []
          : [expect.objectContaining({ utilization: 0.54, observedAt: oldObservedAt })],
      );
    },
  );
});

describe("usage refresh while requests are in flight", () => {
  function markInFlight(pool: Awaited<ReturnType<typeof createGeminiPool>>, id: string) {
    const counts = Reflect.get(pool.hub, "inFlightByAccount");
    if (!(counts instanceof Map)) throw new Error("Missing in-flight map.");
    counts.set(id, 2);
    cleanups.push(async () => {
      counts.delete(id);
    });
  }

  it("refreshes a busy Gemini account on a forced refresh and stamps a new reading", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const oldObservedAt = setStaleUsage(pool);
    markInFlight(pool, pool.account.id);

    const account = await pool.operations.refreshUsage(pool.account.id);

    expect(account?.inFlight).toBe(2);
    expect(account?.observedAt).toBe(pool.now());
    expect(account?.observedAt).not.toBe(oldObservedAt);
  });

  it("refreshes a busy Gemini account on the scheduled interval but not within it", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    markInFlight(pool, pool.account.id);
    const quotaCalls = (endpoint: "daily" | "prod") =>
      pool.calls.filter(
        (url) =>
          url.endsWith(":retrieveUserQuotaSummary") &&
          url.includes(`/${endpoint}/`),
      ).length;
    const before = { daily: quotaCalls("daily"), prod: quotaCalls("prod") };

    await pool.hub.refreshUsage();
    expect(quotaCalls("daily")).toBe(before.daily);
    expect(quotaCalls("prod")).toBe(before.prod);

    pool.advance(6 * MINUTE);
    await pool.hub.refreshUsage();
    expect(quotaCalls("daily")).toBe(before.daily + 1);
    expect(quotaCalls("prod")).toBe(before.prod + 1);
  });

  it("still skips a busy Claude account, even on a forced refresh", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const claude = await pool.accounts.add(
      {
        provider: "claude",
        kind: "oauth",
        label: "synthetic-claude",
        email: null,
        accountUuid: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 0,
      },
      {
        kind: "oauth",
        accessToken: "access-claude",
        refreshToken: "refresh-claude",
        expiresAt: pool.now() + 24 * 60 * MINUTE,
      },
    );
    markInFlight(pool, claude.id);
    const before = pool.calls.length;

    expect(await pool.hub.refreshUsage(claude.id, true)).toBe(true);

    expect(pool.calls.length).toBe(before);
  });
});
