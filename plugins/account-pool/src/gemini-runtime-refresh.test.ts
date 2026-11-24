import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPoolConfigSchema } from "./contracts.js";
import { createHub, type AccountPoolHub } from "./hub.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
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
});

async function createGeminiPool(failedLookups: number, storedError: string | null = null) {
  const dataDir = await fs.mkdtemp(
    path.join(tmpdir(), "bb-account-pool-gemini-runtime-"),
  );
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.bb.storage.database();
  host.bb.storage.migrate(database, QUOTA_MIGRATIONS);
  const secretsDir = path.join(dataDir, "secrets");
  let time = 1_800_000_000_000;
  const now = () => time;
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
      expiresAt: time + 24 * 60 * MINUTE,
    },
  );
  if (storedError !== null)
    quotas.put({ ...quotas.get(account.id), error: storedError });
  let lookups = 0;
  let remainingFailures = failedLookups;
  const runtimeUserAgent = async () => {
    lookups += 1;
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error(LOOKUP_ERROR);
    }
    return RUNTIME_UA;
  };
  const calls: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1internal:loadCodeAssist"))
      return Response.json({
        cloudaicompanionProject: "synthetic-project",
        paidTier: { name: "Google AI Ultra" },
      });
    if (url.endsWith("/v1internal:retrieveUserQuotaSummary"))
      return Response.json({
        buckets: [
          {
            bucketId: "gemini-4-neon",
            remainingFraction: 0.75,
            resetTime: "2100-01-01T00:00:00Z",
          },
        ],
      });
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
    hub,
    quotas,
    calls,
    lookups: () => lookups,
    settled: () => hub.refreshUsage(),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    now,
    summary,
    eligible: async () =>
      (await hub.nextAccountPreview("gemini")).nextAccountId === account.id,
  };
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
    expect(
      pool.calls.filter((url) => url.endsWith(":retrieveUserQuotaSummary")),
    ).toHaveLength(1);
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
