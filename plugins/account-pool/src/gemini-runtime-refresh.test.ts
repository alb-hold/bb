import { randomUUID } from "node:crypto";
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
const QUOTA_READ_PREFIX = "Gemini usage refresh stopped (quota_read): ";
const QUOTA_READ_ERROR = /^Gemini usage refresh stopped \(quota_read\): ./u;

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
  let quotaMode: "normal" | "http" | "unreadable" | "missing" | "empty" | "unknown" | "empty-daily-http-prod" | "a-mixed-b-empty" | "third-party" | "new-project" | "load-http" = "normal";
  let tokenFails = false;
  type GeneratePlan = {
    status: number;
    headers?: Record<string, string>;
    body: string;
    gate?: Promise<void>;
  };
  const generatePlans: GeneratePlan[] = [];
  const gatedBody = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  };
  const gates = new Map<string, { reached: () => void; waiting: Promise<void> }>();
  const hold = (suffix: string) => {
    let reached: () => void = () => {};
    let release: () => void = () => {};
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(suffix, { reached, waiting });
    return { reached: reachedPromise, release };
  };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    for (const [suffix, gate] of gates)
      if (url.endsWith(suffix)) {
        gates.delete(suffix);
        gate.reached();
        await gate.waiting;
      }
    const plan = url.includes(":streamGenerateContent")
      ? generatePlans.shift()
      : undefined;
    if (plan !== undefined) {
      const gate = plan.gate;
      const body =
        gate === undefined
          ? plan.body
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                await gate;
                controller.enqueue(new TextEncoder().encode(plan.body));
                controller.close();
              },
            });
      return new Response(body, {
        status: plan.status,
        headers: {
          "content-type": plan.status === 200 ? "text/event-stream" : "application/json",
          ...plan.headers,
        },
      });
    }
    if (url.includes(":streamGenerateContent"))
      return new Response("data: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    if (url.endsWith("/token") && tokenFails)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (url.endsWith("/token"))
      return Response.json({
        access_token: "access-fresh",
        refresh_token: "refresh-synthetic",
        expires_in: 3600,
      });
    if (url.endsWith("/v1internal:loadCodeAssist") && quotaMode === "load-http")
      return Response.json({ error: "synthetic failure" }, { status: 503 });
    if (url.endsWith("/v1internal:loadCodeAssist"))
      return Response.json({
        cloudaicompanionProject:
          quotaMode === "a-mixed-b-empty"
            ? url.includes("/daily/")
              ? "proj-own"
              : "proj-other"
            : quotaMode === "new-project"
              ? "proj-new"
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
      if (quotaMode === "third-party")
        return Response.json({
          groups: [
            {
              displayName: "Claude and GPT models",
              buckets: [
                { bucketId: "3p-5h", remainingFraction: 0.1 },
                { bucketId: "3p-weekly", remainingFraction: 0.2 },
              ],
            },
          ],
        });
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
  const affinity = new PoolAffinityStore(database);
  const hub: AccountPoolHub = createHub({
    accounts,
    quotas,
    affinity,
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
    geminiOAuthClient: { clientId: "synthetic-client", clientSecret: "synthetic-client-secret" },
    geminiRuntimeUserAgent: runtimeUserAgent,
    onAccountsChanged: () => {},
  });
  const controller = new AbortController();
  const running = hub.start(controller.signal);
  const requestToken = await threadTokens.forThread(
    {
      hostId: "synthetic-host",
      threadId: "synthetic-thread",
      provider: "gemini",
      accountId: null,
    },
    await hubTokens.forHost("synthetic-host"),
    "process",
  );
  const generateRoute =
    "/gemini/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent";
  const request = async () => {
    const response = await hub.handle(
      new Request(
        `https://hub.invalid/api/v1/plugins/account-pool/http${generateRoute}?alt=sse`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${requestToken}`,
            "content-type": "application/json",
            "user-agent": RUNTIME_UA,
          },
          body: JSON.stringify({ contents: [], sessionId: "s" }),
        },
      ),
      "gemini",
      generateRoute,
    );
    await response.text();
    return response.status;
  };
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
    affinity,
    hub,
    operations,
    quotas,
    kv: host.bb.storage.kv,
    calls,
    hold,
    request,
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
    setTokenFails: (value: boolean) => {
      tokenFails = value;
    },
    planGenerate: (plan: GeneratePlan) => {
      generatePlans.push(plan);
    },
    gatedBody,
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

  it.each([
    ["unreadable", "Usage refresh returned unreadable data."],
    ["missing", "Usage refresh returned unreadable data."],
    ["unknown", "Usage refresh returned no recognized quota buckets."],
    ["http", null],
  ] as const)(
    "stores the thrown error of a %s quota read after the runtime lookup recovered, and keeps the windows, project and restriction",
    async (mode, message) => {
      const pool = await createGeminiPool(1);
      await vi.waitFor(async () => {
        expect((await pool.summary()).error).toBe(
          `Gemini usage refresh stopped (runtime_version): ${LOOKUP_ERROR}`,
        );
      });
      const observedAt = setStaleUsage(pool);
      const restriction = {
        reason: "quota_exhausted" as const,
        resetAt: pool.now() + 60 * MINUTE,
      };
      pool.quotas.put({
        ...pool.quotas.get(pool.account.id),
        usageRestriction: restriction,
      });
      const before = pool.quotas.get(pool.account.id);
      const project = (await pool.accounts.get(pool.account.id))?.geminiProject;
      pool.advance(5 * MINUTE + 1_000);
      pool.setQuotaMode(mode);

      expect(await pool.hub.refreshUsage()).toBe(false);

      const after = pool.quotas.get(pool.account.id);
      expect(pool.lookups()).toBe(2);
      expect(after.limitWindows).toEqual(before.limitWindows);
      expect(after.observedAt).toBe(observedAt);
      expect(after.usageRestriction).toEqual(restriction);
      expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe(project);
      if (message === null) expect(after.error).toMatch(QUOTA_READ_ERROR);
      else expect(after.error).toBe(`${QUOTA_READ_PREFIX}${message}`);
      expect(after.error).not.toContain("runtime_version");
    },
  );

  it("recovers on the next scheduled refresh after a stored quota read failure, and the account stays eligible throughout", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    setStaleUsage(pool);
    pool.advance(5 * MINUTE + 1_000);
    pool.setQuotaMode("unreadable");
    expect(await pool.hub.refreshUsage()).toBe(false);
    expect((await pool.summary()).error).toBe(
      `${QUOTA_READ_PREFIX}Usage refresh returned unreadable data.`,
    );
    expect(await pool.eligible()).toBe(true);

    pool.advance(5 * MINUTE + 1_000);
    pool.setQuotaMode("normal");
    await pool.hub.refreshUsage();

    const recovered = await pool.summary();
    expect(recovered.error).toBeNull();
    expect(recovered.observedAt).toBe(pool.now());
    expect(await pool.eligible()).toBe(true);
  });

  it("reports one endpoint empty and the other failed as a failed refresh that records its error, keeps the cached reading and leaves eligibility unchanged", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const observedAt = setStaleUsage(pool);
    expect(await pool.eligible()).toBe(true);
    pool.setQuotaMode("empty-daily-http-prod");

    await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
    expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(0.54);
    expect(pool.quotas.get(pool.account.id).error).toMatch(QUOTA_READ_ERROR);
    expect(await pool.eligible()).toBe(true);
  });

  it("reports an empty read from a later candidate after a mixed failure on an earlier one as a failed refresh that records its error, keeps the cached reading and leaves eligibility unchanged", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const observedAt = setStaleUsage(pool);
    expect(await pool.eligible()).toBe(true);
    pool.setQuotaMode("a-mixed-b-empty");

    await expect(pool.operations.refreshUsage(pool.account.id)).rejects.toThrow(
      "Could not refresh account usage. Try again.",
    );
    expect(pool.quotas.get(pool.account.id).observedAt).toBe(observedAt);
    expect(pool.quotas.get(pool.account.id).limitWindows[0]?.utilization).toBe(0.54);
    expect(pool.quotas.get(pool.account.id).error).toMatch(QUOTA_READ_ERROR);
    expect(await pool.eligible()).toBe(true);
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
      expect(pool.quotas.get(pool.account.id).error).toMatch(QUOTA_READ_ERROR);
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

  const seedExhausted = async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    setStaleUsage(pool);
    const restriction = {
      reason: "quota_exhausted" as const,
      resetAt: pool.now() + 60 * MINUTE,
    };
    pool.quotas.put({ ...pool.quotas.get(pool.account.id), usageRestriction: restriction });
    expect(await pool.eligible()).toBe(false);
    return { pool, restriction };
  };

  it("keeps a stored exhausted restriction through an empty read on every endpoint, so the account stays ineligible", async () => {
    const { pool, restriction } = await seedExhausted();
    pool.setQuotaMode("empty");

    const account = await pool.operations.refreshUsage(pool.account.id);

    expect(account?.limitWindows).toEqual([]);
    expect(account?.observedAt).toBe(pool.now());
    expect(pool.quotas.get(pool.account.id).usageRestriction).toEqual(restriction);
    expect(await pool.eligible()).toBe(false);
    expect((await pool.summary()).status).toBe("exhausted");
  });

  it("clears a stored exhausted restriction when the read has Gemini windows and none is rejected", async () => {
    const { pool } = await seedExhausted();

    await pool.operations.refreshUsage(pool.account.id);

    expect(pool.quotas.get(pool.account.id).usageRestriction).toBeNull();
    expect(await pool.eligible()).toBe(true);
  });

  it.each([
    ["stale windows with no reset time", null],
    ["stale windows whose reset is in the past", -30 * MINUTE],
  ] as const)(
    "does not treat a 3p-only read as a Gemini reading: %s keep the stored restriction, windows and observedAt",
    async (_name, resetOffset) => {
      const { pool, restriction } = await seedExhausted();
      const stored = pool.quotas.get(pool.account.id);
      if (resetOffset !== null)
        pool.quotas.put({
          ...stored,
          limitWindows: stored.limitWindows.map((window) => ({
            ...window,
            resetAt: pool.now() + resetOffset,
          })),
        });
      const before = pool.quotas.get(pool.account.id);
      pool.setQuotaMode("third-party");

      await pool.operations.refreshUsage(pool.account.id);

      const after = pool.quotas.get(pool.account.id);
      expect(after.usageRestriction).toEqual(restriction);
      expect(after.limitWindows).toEqual(before.limitWindows);
      expect(after.observedAt).toBe(before.observedAt);
      expect(after.error).toBeNull();
      expect(await pool.eligible()).toBe(false);
      const display = Object.values(pool.quotas.modelWeekly(pool.account.id) ?? {});
      expect(display.length).toBeGreaterThan(0);
      for (const entry of display) expect(entry.observedAt).toBe(pool.now());
    },
  );

  it.each([
    ["with a stored exhausted restriction", true],
    ["without a restriction", false],
  ] as const)(
    "keeps the old project and the old quota together when the project write fails, %s",
    async (_name, restricted) => {
      const { pool, restriction } = await seedExhausted();
      if (!restricted)
        pool.quotas.put({
          ...pool.quotas.get(pool.account.id),
          usageRestriction: null,
        });
      const before = pool.quotas.get(pool.account.id);
      pool.setQuotaMode("new-project");
      const write = vi
        .spyOn(pool.accounts, "setGeminiProject")
        .mockRejectedValueOnce(new Error("disk full"));

      pool.advance(5 * MINUTE + 1_000);
      expect(await pool.hub.refreshUsage()).toBe(false);

      expect(write).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenLastCalledWith(
        pool.account.id,
        "synthetic-project",
        undefined,
        pool.account.generation,
      );
      expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe(
        "synthetic-project",
      );
      const after = pool.quotas.get(pool.account.id);
      expect(after.limitWindows).toEqual(before.limitWindows);
      expect(after.observedAt).toBe(before.observedAt);
      expect(after.usageRestriction).toEqual(
        restricted ? restriction : null,
      );
      expect(after.error).toBe(`${QUOTA_READ_PREFIX}disk full`);
      expect(await pool.eligible()).toBe(!restricted);
    },
  );

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

describe("Gemini usage refresh writes in the hub", () => {
  const COMMIT_MARKER =
    "Gemini usage refresh stopped (commit): project change to proj-new pending";
  const WRITTEN_COMMIT_MARKER =
    /^Gemini usage refresh stopped \(commit\): project change to proj-new pending \[instance [0-9a-f-]+\]$/u;
  const expireSecret = (pool: Awaited<ReturnType<typeof createGeminiPool>>) =>
    pool.accounts.writeSecret(pool.account.id, {
      kind: "oauth",
      accessToken: "access-synthetic",
      refreshToken: "refresh-synthetic",
      expiresAt: pool.now() - MINUTE,
    });

  it.each([false, true] as const)(
    "keeps a commit marker blocking through a successful credential refresh and a failed load, and a committed reading clears it (forced: %s)",
    async (forced) => {
      const pool = await createGeminiPool(0);
      await pool.settled();
      await expireSecret(pool);
      pool.quotas.put({ ...pool.quotas.get(pool.account.id), error: COMMIT_MARKER });
      pool.advance(10 * MINUTE);
      pool.setQuotaMode("load-http");

      expect(await pool.hub.refreshUsage(undefined, forced)).toBe(false);

      expect(pool.calls.some((url) => url.endsWith("/token"))).toBe(true);
      expect(pool.quotas.get(pool.account.id).error).toBe(COMMIT_MARKER);
      expect(await pool.eligible()).toBe(false);

      pool.advance(10 * MINUTE);
      pool.setQuotaMode("normal");
      expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
      expect(pool.quotas.get(pool.account.id).error).toBeNull();
      expect(await pool.eligible()).toBe(true);
    },
  );

  it("changes no quota, error or project when persisting the refreshed credential fails on a scheduled refresh", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await expireSecret(pool);
    pool.advance(10 * MINUTE);
    const before = pool.quotas.get(pool.account.id);
    const project = (await pool.accounts.get(pool.account.id))?.geminiProject;
    vi.spyOn(pool.accounts, "writeSecret").mockRejectedValueOnce(new Error("disk full"));

    expect(await pool.hub.refreshUsage()).toBe(false);

    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe(project);
    expect(await pool.eligible()).toBe(true);
  });

  it("leaves the quota and error unchanged when the credential write fails on a forced refresh, and the next forced refresh succeeds", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await expireSecret(pool);
    pool.advance(10 * MINUTE);
    const failing = vi.spyOn(pool.accounts, "writeSecret").mockRejectedValueOnce(new Error("disk full"));

    const before = pool.quotas.get(pool.account.id);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);
    expect(pool.quotas.get(pool.account.id)).toEqual(before);

    expect(failing).toHaveBeenCalledTimes(1);
    pool.advance(10 * MINUTE);
    const second = await pool.hub.refreshUsage(undefined, true);
    expect([second, pool.quotas.get(pool.account.id).error]).toEqual([true, null]);
  });

  const beginProjectChange = async (
    heldRefresh: "succeeds" | "fails deleting its rejection" | "is rejected" = "succeeds",
  ) => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    const load = pool.hold("/v1internal:loadCodeAssist");
    const usage = pool.hub.refreshUsage(undefined, true);
    await load.reached;
    await expireSecret(pool);
    if (heldRefresh === "fails deleting its rejection") {
      await rejectOldToken(pool);
      vi.spyOn(pool.accounts, "clearRejectedRefresh").mockRejectedValueOnce(
        new Error("disk full"),
      );
    }
    if (heldRefresh === "is rejected") pool.setTokenFails(true);
    const token = pool.hold("/token");
    const served = pool.request();
    await token.reached;
    const original = pool.accounts.setGeminiProject.bind(pool.accounts);
    let written: () => void = () => {};
    const projectWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    let commit: () => void = () => {};
    const commitGate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let calls = 0;
    let failRestore = false;
    vi.spyOn(pool.accounts, "setGeminiProject").mockImplementation(
      async (...args) => {
        calls += 1;
        if (calls > 1 && failRestore) throw new Error("disk full");
        const account = await original(...args);
        written();
        await commitGate;
        return account;
      },
    );
    load.release();
    await projectWritten;
    expect(pool.quotas.get(pool.account.id).error).toMatch(WRITTEN_COMMIT_MARKER);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
    token.release();
    if (heldRefresh === "succeeds")
      await vi.waitFor(async () => {
        expect((await pool.accounts.readSecret(pool.account.id)).kind).toBe("oauth");
        const secret = await pool.accounts.readSecret(pool.account.id);
        expect(secret.kind === "oauth" ? secret.accessToken : null).toBe("access-fresh");
      });
    await served;
    return {
      pool,
      usage,
      finish: (failCommit: boolean) => {
        failRestore = failCommit;
        if (failCommit)
          vi.spyOn(pool.quotas, "commitReading").mockImplementation(() => {
            throw new Error("disk full");
          });
        commit();
        return usage;
      },
    };
  };

  it("keeps the marker blocking when a request refresh that began before it finishes during the project change, and a committed reading clears it", async () => {
    const { pool, finish } = await beginProjectChange();

    expect(await finish(true)).toBe(false);

    expect(pool.quotas.get(pool.account.id).error).toMatch(WRITTEN_COMMIT_MARKER);
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);

    vi.restoreAllMocks();
    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
    expect(await pool.eligible()).toBe(true);
    expect(await pool.request()).toBe(200);
  });

  it("keeps the marker blocking after that refresh finishes while the project change has not committed at all", async () => {
    const { pool, finish } = await beginProjectChange();

    expect(pool.quotas.get(pool.account.id).error).toMatch(WRITTEN_COMMIT_MARKER);
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);

    expect(await finish(false)).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  it.each(["fails deleting its rejection", "is rejected"] as const)(
    "keeps the marker blocking when the held request refresh %s during the project change, and a committed reading clears it",
    async (heldRefresh) => {
      const { pool, finish } = await beginProjectChange(heldRefresh);
      expect(pool.quotas.get(pool.account.id).error).toMatch(WRITTEN_COMMIT_MARKER);

      expect(await finish(true)).toBe(false);

      expect(pool.quotas.get(pool.account.id).error).toMatch(WRITTEN_COMMIT_MARKER);
      expect(await pool.eligible()).toBe(false);
      expect(await pool.request()).not.toBe(200);

      vi.restoreAllMocks();
      pool.setTokenFails(false);
      pool.advance(10 * MINUTE);
      expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
      expect(pool.quotas.get(pool.account.id).error).toBeNull();
      expect(await pool.eligible()).toBe(true);
      expect(await pool.request()).toBe(200);
    },
  );

  it("still replaces a non-marker error with the hub's error write", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await expireSecret(pool);
    pool.setTokenFails(true);
    expect(await pool.request()).not.toBe(200);
    expect(pool.quotas.get(pool.account.id).error).toContain("invalid_grant");
  });

  const QUOTA_EXHAUSTED_BODY = JSON.stringify({
    error: {
      status: "RESOURCE_EXHAUSTED",
      details: [
        { reason: "QUOTA_EXHAUSTED", metadata: { quotaResetDelay: "3600s" } },
      ],
    },
  });
  const flush = async () => {
    for (let index = 0; index < 5; index += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const streamCalls = (pool: Awaited<ReturnType<typeof createGeminiPool>>) =>
    pool.calls.filter((url) => url.includes(":streamGenerateContent")).length;

  it.each([
    [
      "a 429 with a retry-after",
      { status: 429, headers: { "retry-after": "3600" }, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }) },
      429,
    ],
    [
      "a 429 body rejection",
      { status: 429, body: QUOTA_EXHAUSTED_BODY },
      429,
    ],
    [
      "a quota rejection inside a stream",
      { status: 200, body: `data: ${QUOTA_EXHAUSTED_BODY}\n\n` },
      200,
    ],
  ] as const)(
    "does not let a late response from the old project write its %s over the committed new project",
    async (_name, plan, status) => {
      const pool = await createGeminiPool(0);
      await pool.settled();
      const body = pool.gatedBody();
      pool.planGenerate({ ...plan, gate: body.gate });
      const served = pool.request();
      await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
      await flush();

      pool.setQuotaMode("new-project");
      pool.advance(10 * MINUTE);
      expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
      expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
      const committed = pool.quotas.get(pool.account.id);
      expect(committed.error).toBeNull();

      body.release();
      expect(await served).toBe(status);
      await flush();

      expect(pool.quotas.get(pool.account.id)).toEqual(committed);
      expect(await pool.eligible()).toBe(true);
      expect(await pool.request()).toBe(200);
    },
  );

  const RETRY_AFTER_PLAN = {
    status: 429,
    headers: { "retry-after": "3600" },
    body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
  };
  const failGeminiAccountWrite = (pool: Awaited<ReturnType<typeof createGeminiPool>>) => {
    const original = pool.kv.set.bind(pool.kv);
    let failed = false;
    vi.spyOn(pool.kv, "set").mockImplementation(async (...args) => {
      if (args[0] === "accounts:gemini:v1" && !failed) {
        failed = true;
        throw new Error("disk full");
      }
      return original(...args);
    });
  };
  const holdOldProjectRequest = async (
    pool: Awaited<ReturnType<typeof createGeminiPool>>,
  ) => {
    const body = pool.gatedBody();
    pool.planGenerate({ ...RETRY_AFTER_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();
    return { body, served };
  };

  it("persists the hold of an old-project response when the account store failed to change the project", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const { body, served } = await holdOldProjectRequest(pool);

    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    failGeminiAccountWrite(pool);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);

    body.release();
    expect(await served).toBe(429);
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);
  });

  it("persists the hold of an old-project response when the commit failed and the project was restored", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const { body, served } = await holdOldProjectRequest(pool);

    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    vi.spyOn(pool.quotas, "commitReading").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");

    body.release();
    expect(await served).toBe(429);
    await flush();

    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();
    expect(await pool.eligible()).toBe(false);
  });

  it("still drops an old-project response after a failed account-store write that follows a committed project change", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const { body, served } = await holdOldProjectRequest(pool);

    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    const committed = pool.quotas.get(pool.account.id);
    failGeminiAccountWrite(pool);
    const endpoint = (await pool.accounts.get(pool.account.id))?.geminiEndpoint === "prod" ? "daily" : "prod";
    await expect(pool.accounts.setGeminiEndpoint(pool.account.id, endpoint)).rejects.toThrow("disk full");

    body.release();
    expect(await served).toBe(429);
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
    expect(pool.quotas.get(pool.account.id)).toEqual(committed);
  });

  const failGeminiAccountWrites = (
    pool: Awaited<ReturnType<typeof createGeminiPool>>,
    plan: readonly ("persist-then-reject" | "reject")[],
  ) => {
    const original = pool.kv.set.bind(pool.kv);
    const remaining = [...plan];
    vi.spyOn(pool.kv, "set").mockImplementation(async (...args) => {
      const step = args[0] === "accounts:gemini:v1" ? remaining.shift() : undefined;
      if (step === "persist-then-reject") {
        await original(...args);
        throw new Error("disk full after write");
      }
      if (step === "reject") throw new Error("disk full");
      return original(...args);
    });
  };

  it("restores the old project when the account store stored the new one and then rejected", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    failGeminiAccountWrites(pool, ["persist-then-reject"]);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id).error).toContain("quota_read");
    pool.setQuotaMode("normal");
    expect(await pool.request()).toBe(200);
  });

  it("keeps the blocking marker when the account store stored the new project, rejected, and the restore also rejected", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    failGeminiAccountWrites(pool, ["persist-then-reject", "reject"]);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);

    const error = pool.quotas.get(pool.account.id).error;
    expect(error).toContain("commit");
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);

    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
    expect(await pool.eligible()).toBe(true);
  });

  it("still writes the observed fields of a response from a re-added account with the same id", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    failGeminiAccountWrites(pool, ["reject"]);
    await expect(pool.accounts.setEnabled(pool.account.id, false)).rejects.toThrow("disk full");
    await pool.kv.set("accounts:gemini:v1", [
      { ...pool.account, createdAt: pool.account.createdAt + 1, generation: randomUUID(), geminiProject: "synthetic-project" },
    ]);
    pool.setQuotaMode("normal");
    pool.advance(10 * MINUTE);
    await pool.hub.refreshUsage(undefined, true);
    pool.planGenerate({
      status: 429,
      headers: { "retry-after": "3600" },
      body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
    });
    expect(await pool.request()).toBe(429);
    await flush();
    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();
  });

  const reAddSameId = async (
    pool: Awaited<ReturnType<typeof createGeminiPool>>,
    geminiProject: string,
    quiet = false,
    sameCreatedAt = false,
  ) => {
    expect(
      await (quiet
        ? pool.accounts.remove(pool.account.id)
        : pool.operations.remove(pool.account.id)),
    ).toBe(true);
    await pool.kv.set("accounts:gemini:v1", [
      {
        ...pool.account,
        createdAt: pool.account.createdAt + (sameCreatedAt ? 0 : 1),
        generation: randomUUID(),
        geminiProject,
      },
    ]);
    (pool.accounts as unknown as { geminiCache: null }).geminiCache = null;
    await pool.accounts.writeSecret(pool.account.id, {
      kind: "oauth",
      accessToken: "access-synthetic",
      refreshToken: "refresh-synthetic",
      expiresAt: pool.now() + 24 * 60 * MINUTE,
    });
  };
  const commitNewProject = async (pool: Awaited<ReturnType<typeof createGeminiPool>>) => {
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
  };
  const OLD_RESTRICTION_PLAN = { status: 429, body: QUOTA_EXHAUSTED_BODY };

  it("drops a pending old-instance response after a same-id re-add even when a new-instance response went through first", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...OLD_RESTRICTION_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    await commitNewProject(pool);
    await reAddSameId(pool, "proj-new");
    await pool.hub.refreshUsage(undefined, true);
    pool.planGenerate({ status: 429, headers: { "retry-after": "60" }, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }) });
    expect(await pool.request()).toBe(429);
    await flush();
    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();

    body.release();
    await served;
    await flush();

    expect(pool.quotas.get(pool.account.id).usageRestriction).toBeNull();
    pool.advance(2 * MINUTE);
    pool.planGenerate({ status: 200, body: "data: {}\n\n" });
    expect(await pool.eligible()).toBe(true);
    expect(await pool.request()).toBe(200);
  });

  it("drops an old-project response that arrives after a credential replacement", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...OLD_RESTRICTION_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    await commitNewProject(pool);
    await pool.hub.replaceSecret(
      pool.account.id,
      { kind: "api-key", apiKey: "synthetic-api-key" },
      async () => {},
    );
    body.release();
    await served;
    await flush();

    expect(pool.quotas.get(pool.account.id).usageRestriction).toBeNull();
  });

  it("drops a response that arrives after its account was removed, and a later re-add starts clean", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...OLD_RESTRICTION_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    await reAddSameId(pool, "synthetic-project");
    body.release();
    await served;
    await flush();

    const stored = pool.quotas.get(pool.account.id);
    expect(stored.usageRestriction).toBeNull();
    expect(stored.heldUntil).toBeNull();
    expect(stored.observedAt).toBeNull();
  });

  it("drops a response that arrives after its account was removed and not re-added", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...OLD_RESTRICTION_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    expect(await pool.operations.remove(pool.account.id)).toBe(true);
    body.release();
    await served;
    await flush();

    expect(pool.quotas.get(pool.account.id).usageRestriction).toBeNull();
    expect(pool.quotas.get(pool.account.id).observedAt).toBeNull();
  });

  const QUOTA_CALL = "/v1internal:retrieveUserQuotaSummary";
  const holdUsageRefresh = async (pool: Awaited<ReturnType<typeof createGeminiPool>>) => {
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    const held = pool.hold(QUOTA_CALL);
    const refresh = pool.hub.refreshUsage(undefined, true);
    await held.reached;
    return { held, refresh };
  };

  it("writes nothing from a usage refresh held across a removal and a same-id re-add", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);

    await reAddSameId(pool, "synthetic-project");
    const before = pool.quotas.get(pool.account.id);
    held.release();
    await refresh;
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    pool.setQuotaMode("normal");
    expect(await pool.eligible()).toBe(true);
    expect(await pool.request()).toBe(200);
  });

  it("writes no commit marker or project from a usage refresh whose account was replaced without an abort", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);

    await reAddSameId(pool, "synthetic-project", true);
    expect(await pool.request()).toBe(200);
    const before = pool.quotas.get(pool.account.id);
    held.release();
    await refresh;
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
  });

  it("treats a refused project compare-and-set as stale when no removal event, request or sync happened", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);

    await reAddSameId(pool, "synthetic-project", true);
    const quotaBefore = pool.quotas.get(pool.account.id);
    const displayBefore = pool.quotas.modelWeekly(pool.account.id);
    held.release();
    await refresh;
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id)).toEqual(quotaBefore);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(displayBefore);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  it("writes no error from a usage refresh that fails after a same-id replacement with no sync", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);

    await reAddSameId(pool, "synthetic-project", true);
    const before = pool.quotas.get(pool.account.id);
    pool.setQuotaMode("http");
    held.release();
    await refresh;
    await flush();

    expect(pool.quotas.get(pool.account.id)).toEqual(before);
  });

  it("writes no error from a usage refresh that fails after its account was replaced", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);

    await reAddSameId(pool, "synthetic-project", true);
    expect(await pool.request()).toBe(200);
    const before = pool.quotas.get(pool.account.id);
    pool.setQuotaMode("http");
    held.release();
    await refresh;
    await flush();

    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  it("drops a gated Retry-After 429 from the old instance after a same-id replacement with no removal event, request or sync", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...RETRY_AFTER_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    await reAddSameId(pool, "synthetic-project", true);
    const quotaBefore = pool.quotas.get(pool.account.id);
    const displayBefore = pool.quotas.modelWeekly(pool.account.id);
    body.release();
    await served;
    await flush();

    const stored = pool.quotas.get(pool.account.id);
    expect(stored.heldUntil).toBeNull();
    expect(stored.usageRestriction).toBeNull();
    expect(stored).toEqual(quotaBefore);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(displayBefore);
  });

  it("drops a gated 200 response carrying a quota rejection from the old instance after a same-id replacement with no removal event, request or sync", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ status: 200, body: `data: ${QUOTA_EXHAUSTED_BODY}\n\n`, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    await reAddSameId(pool, "synthetic-project", true);
    const quotaBefore = pool.quotas.get(pool.account.id);
    const displayBefore = pool.quotas.modelWeekly(pool.account.id);
    body.release();
    await served;
    await flush();

    expect(pool.quotas.get(pool.account.id).usageRestriction).toBeNull();
    expect(pool.quotas.get(pool.account.id)).toEqual(quotaBefore);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(displayBefore);
  });

  it("still writes the hold of a gated Retry-After 429 on the current instance", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...RETRY_AFTER_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    body.release();
    await served;
    await flush();

    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();
  });

  const pauseAtProjectWrite = async (pool: Awaited<ReturnType<typeof createGeminiPool>>) => {
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    const original = pool.accounts.setGeminiProject.bind(pool.accounts);
    const gate = pool.gatedBody();
    let reached: () => void = () => {};
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(pool.accounts, "setGeminiProject").mockImplementationOnce(async (...args) => {
      reached();
      await gate.gate;
      return original(...args);
    });
    const refresh = pool.hub.refreshUsage(undefined, true);
    await atWrite;
    return { gate, refresh };
  };

  it("leaves the marker on a replacement's quota row when a stale refresh was replaced after its marker write, and unblocks only on the replacement's own reading", async () => {
    const pool = await createGeminiPool(0);
    const { gate, refresh } = await pauseAtProjectWrite(pool);
    const staleMarker = pool.quotas.get(pool.account.id).error;
    expect(staleMarker).toContain("project change to proj-new pending [instance ");

    await reAddSameId(pool, "synthetic-replacement", true);
    const before = pool.quotas.get(pool.account.id);
    const display = pool.quotas.modelWeekly(pool.account.id);
    expect(before.error).toBe(staleMarker);
    gate.release();
    await refresh;
    await flush();

    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(display);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-replacement");
    pool.setQuotaMode("normal");
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);
    expect(pool.quotas.get(pool.account.id)).toEqual(before);

    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
    expect(await pool.eligible()).toBe(true);
  });

  it("leaves no marker behind when the refreshing account is removed with its quota row after the marker write", async () => {
    const pool = await createGeminiPool(0);
    const { gate, refresh } = await pauseAtProjectWrite(pool);
    expect(pool.quotas.get(pool.account.id).error).toContain("pending");

    expect(await pool.operations.remove(pool.account.id)).toBe(true);
    gate.release();
    await refresh;
    await flush();

    expect(await pool.accounts.get(pool.account.id)).toBeNull();
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  it("keeps a replacement with the same id and the same createdAt untouched by a held usage refresh", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);
    await reAddSameId(pool, "synthetic-project", true, true);
    const replaced = await pool.accounts.get(pool.account.id);
    expect(replaced?.createdAt).toBe(pool.account.createdAt);
    expect(replaced?.generation).not.toBe(pool.account.generation);
    const before = pool.quotas.get(pool.account.id);
    const display = pool.quotas.modelWeekly(pool.account.id);
    held.release();
    await refresh;
    await flush();
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(display);
  });

  it("keeps a replacement with the same id and the same createdAt untouched by a gated response", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const body = pool.gatedBody();
    pool.planGenerate({ ...RETRY_AFTER_PLAN, gate: body.gate });
    const served = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();
    await reAddSameId(pool, "synthetic-project", true, true);
    const before = pool.quotas.get(pool.account.id);
    const display = pool.quotas.modelWeekly(pool.account.id);
    body.release();
    await served;
    await flush();
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(pool.quotas.get(pool.account.id).heldUntil).toBeNull();
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(display);
  });

  it("keeps a replacement with the same id and the same createdAt untouched by a held marker cleanup", async () => {
    const pool = await createGeminiPool(0);
    const paused = await pauseAtProjectWrite(pool);
    const marker = pool.quotas.get(pool.account.id).error;
    expect(marker).toMatch(WRITTEN_COMMIT_MARKER);
    await reAddSameId(pool, "synthetic-replacement", true, true);
    const before = pool.quotas.get(pool.account.id);
    const display = pool.quotas.modelWeekly(pool.account.id);
    paused.gate.release();
    await paused.refresh;
    await flush();
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(pool.quotas.get(pool.account.id).error).toBe(marker);
    expect(pool.quotas.modelWeekly(pool.account.id)).toEqual(display);
    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-replacement");
  });

  it("rejects a project write that lands after its account was removed and re-added", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.setQuotaMode("new-project");
    pool.advance(10 * MINUTE);
    const original = pool.accounts.setGeminiProject.bind(pool.accounts);
    const gate = pool.gatedBody();
    let reached: () => void = () => {};
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(pool.accounts, "setGeminiProject").mockImplementationOnce(async (...args) => {
      reached();
      await gate.gate;
      return original(...args);
    });
    const refresh = pool.hub.refreshUsage(undefined, true);
    await atWrite;

    await reAddSameId(pool, "synthetic-project");
    const before = pool.quotas.get(pool.account.id);
    gate.release();
    await refresh;
    await flush();

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("synthetic-project");
    expect(pool.quotas.get(pool.account.id)).toEqual(before);
  });

  it("still commits a usage refresh that is held and released with no removal", async () => {
    const pool = await createGeminiPool(0);
    const { held, refresh } = await holdUsageRefresh(pool);
    held.release();
    expect(await refresh).toBe(true);

    expect((await pool.accounts.get(pool.account.id))?.geminiProject).toBe("proj-new");
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
    expect(await pool.eligible()).toBe(true);
  });

  it("writes the response of a new instance after a same-id re-add", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await commitNewProject(pool);
    await reAddSameId(pool, "proj-new");
    await pool.hub.refreshUsage(undefined, true);
    pool.planGenerate({ status: 429, headers: { "retry-after": "3600" }, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }) });
    expect(await pool.request()).toBe(429);
    await flush();
    expect(pool.quotas.get(pool.account.id).heldUntil).not.toBeNull();
  });

  it("still writes the observed fields of a response on the current project", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.planGenerate({ status: 429, body: QUOTA_EXHAUSTED_BODY });
    expect(await pool.request()).toBe(429);
    expect(pool.quotas.get(pool.account.id).usageRestriction?.reason).toBe("quota_exhausted");

    const held = await createGeminiPool(0);
    await held.settled();
    held.planGenerate({
      status: 429,
      headers: { "retry-after": "3600" },
      body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
    });
    expect(await held.request()).toBe(429);
    expect(held.quotas.get(held.account.id).heldUntil).not.toBeNull();
  });

  it("merges onto the stored row, so a later write from one request does not erase what another request wrote", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    const first = pool.gatedBody();
    pool.planGenerate({
      status: 429,
      headers: { "retry-after": "3600" },
      body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
      gate: first.gate,
    });
    const slow = pool.request();
    await vi.waitFor(() => expect(streamCalls(pool)).toBe(1));
    await flush();

    pool.planGenerate({ status: 200, body: `data: ${QUOTA_EXHAUSTED_BODY}\n\n` });
    expect(await pool.request()).toBe(200);
    await flush();
    const restriction = pool.quotas.get(pool.account.id).usageRestriction;
    expect(restriction?.reason).toBe("quota_exhausted");

    first.release();
    expect(await slow).toBe(429);
    await flush();

    const stored = pool.quotas.get(pool.account.id);
    expect(stored.usageRestriction).toEqual(restriction);
    expect(stored.heldUntil).not.toBeNull();
  });

  it("clears a credential error when a request refresh succeeds", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await expireSecret(pool);
    const token = pool.hold("/token");
    const served = pool.request();
    await token.reached;
    pool.quotas.put({ ...pool.quotas.get(pool.account.id), error: AUTH_ERROR });
    token.release();
    await served;

    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  it("keeps a stored quota_read error through a successful request refresh, and the next committed reading clears it", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await expireSecret(pool);
    const stored = `${QUOTA_READ_PREFIX}synthetic failure`;
    pool.quotas.put({ ...pool.quotas.get(pool.account.id), error: stored });

    expect(await pool.request()).toBe(200);
    expect(pool.calls.some((url) => url.endsWith("/token"))).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBe(stored);

    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(pool.quotas.get(pool.account.id).error).toBeNull();
  });

  const rejectOldToken = async (pool: Awaited<ReturnType<typeof createGeminiPool>>) => {
    await pool.accounts.recordRejectedRefresh(pool.account.id, "refresh-old", AUTH_ERROR);
    expect(await pool.accounts.rejectedRefresh(pool.account.id, "refresh-synthetic")).toEqual({
      message: AUTH_ERROR,
      sameToken: false,
    });
  };

  it("deletes the stored rejection of an older token when a refresh succeeds, on a usage refresh and on a request", async () => {
    const usagePool = await createGeminiPool(0);
    await usagePool.settled();
    await rejectOldToken(usagePool);
    await expireSecret(usagePool);
    usagePool.advance(10 * MINUTE);
    expect(await usagePool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(await usagePool.accounts.rejectedRefresh(usagePool.account.id, "refresh-synthetic")).toBeNull();

    const requestPool = await createGeminiPool(0);
    await requestPool.settled();
    await rejectOldToken(requestPool);
    await expireSecret(requestPool);
    expect(await requestPool.request()).toBe(200);
    expect(await requestPool.accounts.rejectedRefresh(requestPool.account.id, "refresh-synthetic")).toBeNull();
  });

  it("fails the usage refresh without changing quota or error when deleting the stored rejection throws, and the next refresh deletes it", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await rejectOldToken(pool);
    await expireSecret(pool);
    pool.advance(10 * MINUTE);
    const before = pool.quotas.get(pool.account.id);
    vi.spyOn(pool.accounts, "clearRejectedRefresh").mockRejectedValueOnce(new Error("disk full"));

    expect(await pool.hub.refreshUsage(undefined, true)).toBe(false);

    expect(pool.quotas.get(pool.account.id)).toEqual(before);
    expect(await pool.accounts.rejectedRefresh(pool.account.id, "refresh-synthetic")).not.toBeNull();
    pool.advance(10 * MINUTE);
    expect(await pool.hub.refreshUsage(undefined, true)).toBe(true);
    expect(await pool.accounts.rejectedRefresh(pool.account.id, "refresh-synthetic")).toBeNull();
  });

  it("records the error and refuses requests when deleting the stored rejection throws on a request", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    await rejectOldToken(pool);
    await expireSecret(pool);
    vi.spyOn(pool.accounts, "clearRejectedRefresh").mockRejectedValueOnce(new Error("disk full"));

    expect(await pool.request()).not.toBe(200);

    expect(pool.quotas.get(pool.account.id).error).toBe("disk full");
    expect(await pool.eligible()).toBe(false);
    expect(await pool.request()).not.toBe(200);
  });

  it("writes no affinity, active-account or automatic-choice row during a usage refresh", async () => {
    const pool = await createGeminiPool(0);
    await pool.settled();
    pool.advance(10 * MINUTE);
    const writes = [
      vi.spyOn(pool.affinity, "putBinding"),
      vi.spyOn(pool.affinity, "putActiveAccount"),
      vi.spyOn(pool.affinity, "putAutomaticChoice"),
      vi.spyOn(pool.affinity, "removeBinding"),
    ];
    await pool.hub.refreshUsage(undefined, true);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});
