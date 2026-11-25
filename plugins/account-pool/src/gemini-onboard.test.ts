import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Account, accountSchema } from "./contracts.js";
import { createGeminiAdapter, geminiWindowsFromQuota } from "./gemini-adapter.js";
import type { AdapterUsageContext } from "./provider-adapter.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";
import { antigravityRuntimeUserAgent } from "./gemini-gateway.js";

const TOKEN = "access-token-onboard";
const EMAIL = "pro-user@example.com";
const BASES = {
  prod: "https://code-assist.test/prod",
  daily: "https://code-assist.test/daily",
};
const AGY_AGENT = "antigravity/acp/1.5.0 (aidev_client; os_type=darwin; arch=arm64)";
const AGY_REQUEST = /^antigravity\/acp\/[0-9][^ ]* \(aidev_client; os_type=[a-z]+; arch=[a-z0-9]+\)$/u;

interface FakeCall {
  method: string;
  base: string;
  body: Record<string, unknown> | null;
  userAgent: string | null;
}

function fakeCodeAssist(script: {
  loads: unknown[];
  loadsByBase?: Partial<Record<"prod" | "daily", unknown[]>>;
  loadFailureByBase?: Partial<Record<"prod" | "daily", { status: number } | Error>>;
  onboard?: unknown;
  onboardReplies?: unknown[];
  operations?: unknown[];
  onboardFailure?: { status: number } | { error: Error };
  quota?: unknown;
  quotaByBase?: Partial<Record<"prod" | "daily", unknown>>;
  quotaFailureByBase?: Partial<Record<"prod" | "daily", number>>;
  quotaByProject?: Record<string, unknown>;
  quotaByProjectBase?: Record<string, Partial<Record<"prod" | "daily", unknown>>>;
  quotaFailureByProjectBase?: Record<string, Partial<Record<"prod" | "daily", number>>>;
  runtimeUserAgent?: () => Promise<string>;
  unrecognizedClientLoad?: unknown;
  now?: () => number;
}) {
  const calls: FakeCall[] = [];
  const loads = [...script.loads];
  const loadsByBase = {
    prod: [...(script.loadsByBase?.prod ?? [])],
    daily: [...(script.loadsByBase?.daily ?? [])],
  };
  const operations = [...(script.operations ?? [])];
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const doFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://oauth.test/token")
      return json({ access_token: TOKEN, expires_in: 3600 });
    if (url === "https://userinfo.test/") return json({ email: EMAIL });
    const base = url.startsWith(BASES.prod) ? "prod" : "daily";
    const rest = url.slice(base === "prod" ? BASES.prod.length : BASES.daily.length);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    const userAgent = new Headers(init?.headers).get("user-agent");
    if (rest === "/v1internal:loadCodeAssist") {
      calls.push({ method: "loadCodeAssist", base, body, userAgent });
      if (script.unrecognizedClientLoad !== undefined && !AGY_REQUEST.test(userAgent ?? ""))
        return json(script.unrecognizedClientLoad);
      const failure = script.loadFailureByBase?.[base];
      if (failure instanceof Error) throw failure;
      if (failure) return new Response("{}", { status: failure.status });
      const source = script.loadsByBase?.[base]
        ? loadsByBase[base]
        : loads;
      return json(source.length > 1 ? source.shift() : source[0]);
    }
    if (rest === "/v1internal:onboardUser") {
      calls.push({ method: "onboardUser", base, body, userAgent });
      if (script.onboardFailure !== undefined) {
        if ("error" in script.onboardFailure) throw script.onboardFailure.error;
        return new Response("{}", { status: script.onboardFailure.status });
      }
      return json(script.onboardReplies?.shift() ?? script.onboard);
    }
    if (rest === "/v1internal:retrieveUserQuotaSummary") {
      calls.push({ method: "retrieveUserQuotaSummary", base, body, userAgent });
      const failureStatus = script.quotaFailureByBase?.[base];
      if (failureStatus !== undefined)
        return new Response("{}", { status: failureStatus });
      const project = typeof body?.project === "string" ? body.project : "";
      const projectFailure = script.quotaFailureByProjectBase?.[project]?.[base];
      if (projectFailure !== undefined)
        return new Response("{}", { status: projectFailure });
      const byProjectBase = script.quotaByProjectBase?.[project]?.[base];
      if (byProjectBase !== undefined) return json(byProjectBase);
      const byProject = script.quotaByProject?.[project];
      if (byProject !== undefined) return json(byProject);
      const byBase = script.quotaByBase?.[base];
      if (byBase !== undefined) return json(byBase);
      return script.quota === undefined
        ? new Response("{}", { status: 404 })
        : json(script.quota);
    }
    if (rest.startsWith("/v1internal/operations/")) {
      calls.push({ method: "getOperation", base, body, userAgent });
      return json(operations.length > 1 ? operations.shift() : operations[0]);
    }
    return new Response("{}", { status: 404 });
  };
  const adapter = createGeminiAdapter({
    refreshUrl: "https://oauth.test/token",
    userinfoUrl: "https://userinfo.test/",
    upstreamBaseUrls: BASES,
    fetch: doFetch,
    importCredentials: async () => ({
      refreshToken: "refresh-onboard",
      client: { clientId: "agy-client", clientSecret: "agy-secret" },
      projectId: null,
      source: { kind: "file", path: "/fake-home/antigravity-acp/acp_token.json" },
      storedExpiresAt: Date.parse("2026-11-23T12:00:00Z"),
    }),
    onboarding: { pollMs: 5, timeoutMs: 60 },
    runtimeUserAgent: script.runtimeUserAgent ?? (async () => AGY_AGENT),
    ...(script.now === undefined ? {} : { now: script.now }),
  });
  return { adapter, calls, fetch: doFetch };
}

const DAILY_NO_PROJECT = { currentTier: { id: "free-tier" } };
const PROD_STANDARD_NO_PROJECT = {
  currentTier: null,
  paidTier: null,
  allowedTiers: [{ id: "standard-tier", isDefault: true }],
};

const PROD_SERVED_DAILY = {
  cloudaicompanionProject: "proj-gcp-daily",
  currentTier: { id: "standard-tier" },
  paidTier: { id: "enterprise-tier", usesGcpTos: true },
};
const PROD_SERVED_PROD = {
  cloudaicompanionProject: "proj-gcp-prod",
  currentTier: { id: "standard-tier" },
  paidTier: { id: "enterprise-tier", usesGcpTos: true },
};

describe("choosing the project for an account both endpoints know", () => {
  it("keeps prod's project and endpoint for a prod-served account whose daily project differs", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: { daily: [PROD_SERVED_DAILY], prod: [PROD_SERVED_PROD] },
    });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-gcp-prod",
      geminiEndpoint: "prod",
      subscriptionType: "enterprise-tier",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it.each<[string, Omit<Parameters<typeof fakeCodeAssist>[0], "loads">]>([
    ["has no project", { loadsByBase: { daily: [PROD_SERVED_DAILY], prod: [PROD_STANDARD_NO_PROJECT] } }],
    ["fails", { loadsByBase: { daily: [PROD_SERVED_DAILY] }, loadFailureByBase: { prod: { status: 503 } } }],
  ])("uses daily's project for a prod-served account when prod %s", async (_name, script) => {
    const google = fakeCodeAssist({ loads: [], ...script });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-gcp-daily",
      geminiEndpoint: "prod",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("keeps daily's project for a daily-served account without loading prod", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [
          {
            cloudaicompanionProject: "proj-ultra-daily",
            currentTier: { id: "standard-tier" },
            paidTier: { id: "g1-ultra-tier", usesGcpTos: false },
          },
        ],
        prod: [
          {
            cloudaicompanionProject: "proj-ultra-prod",
            currentTier: { id: "standard-tier" },
            paidTier: { id: "g1-ultra-tier", usesGcpTos: false },
          },
        ],
      },
    });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-ultra-daily",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
    ]);
  });
});

describe("adding a Google AI Pro account to the Gemini pool", () => {
  it("adds an account whose tier comes with an id and no name", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          cloudaicompanionProject: "proj-pro",
          currentTier: { id: "standard-tier" },
          paidTier: { id: "g1-pro-tier" },
        },
      ],
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      email: EMAIL,
      geminiProject: "proj-pro",
      subscriptionType: "g1-pro-tier",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
  });

  it("records the paid tier even when only the free current tier has a name", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          cloudaicompanionProject: "proj-pro",
          currentTier: { id: "free-tier", name: "Free" },
          paidTier: { id: "g1-pro-tier" },
        },
      ],
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-pro",
      subscriptionType: "g1-pro-tier",
    });
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
  });

  it("treats an empty paid tier as missing and falls back to the current tier", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          cloudaicompanionProject: "proj-std",
          currentTier: { id: "standard-tier", name: "Standard" },
          paidTier: { id: "", name: " " },
        },
      ],
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-std",
      subscriptionType: "Standard",
    });
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
  });

  it("onboards an account with no project yet, waits for the operation, then adds it", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [DAILY_NO_PROJECT],
        prod: [
          {
            currentTier: { id: "free-tier" },
            allowedTiers: [
              { id: "free-tier" },
              { id: "g1-pro-tier", isDefault: true },
            ],
          },
          {
            cloudaicompanionProject: "proj-new",
            currentTier: { id: "g1-pro-tier" },
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
          },
        ],
      },
      onboard: { name: "operations/onboard-1", done: false },
      operations: [
        {
          name: "operations/onboard-1",
          done: true,
          response: { cloudaicompanionProject: { id: "proj-new" } },
        },
      ],
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-new",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["getOperation", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
    expect(google.calls[2]?.body).toMatchObject({ tierId: "g1-pro-tier" });
  });

  it("onboards to the paid tier, not the free current tier, when Google marks no default", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [DAILY_NO_PROJECT],
        prod: [
          {
            currentTier: { id: "free-tier" },
            paidTier: { id: "g1-pro-tier" },
            allowedTiers: [{ id: "free-tier" }, { id: "g1-pro-tier" }],
          },
          {
            cloudaicompanionProject: "proj-paid",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
          },
        ],
      },
      onboard: {
        name: "operations/onboard-3",
        done: true,
        response: { cloudaicompanionProject: "proj-paid" },
      },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-paid",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls[2]).toMatchObject({
      method: "onboardUser",
      base: "prod",
      body: { tierId: "g1-pro-tier" },
    });
  });

  const standard = { currentTier: { id: "standard-tier" } };

  it.each(["proj-new", { id: "proj-new", name: "Project" }])(
    "reads the project from the completed operation (%j)",
    async (project) => {
      const google = fakeCodeAssist({
        loads: [standard],
        onboardReplies: [{ done: false }, { name: "operations/new" }],
        operations: [{ done: false }, { done: true, response: { cloudaicompanionProject: project } }],
      });
      expect(await google.adapter.importAccount()).toMatchObject({ geminiProject: "proj-new" });
      expect(google.calls.map(call => call.method)).toEqual([
        "loadCodeAssist", "loadCodeAssist", "onboardUser", "onboardUser", "getOperation", "getOperation", "loadCodeAssist",
      ]);
    },
  );

  it.each([{}, { cloudaicompanionProject: {} }])(
    "identifies the missing standard-tier project (%j)",
    async response => {
      const google = fakeCodeAssist({ loads: [standard], onboard: { done: true, response } });
      await expect(google.adapter.importAccount()).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
    },
  );

  it("reports malformed field paths without their values", async () => {
    const google = fakeCodeAssist({
      loads: [standard],
      onboard: { done: true, response: { cloudaicompanionProject: { id: [TOKEN], name: EMAIL } } },
    });
    const error = await google.adapter.importAccount().catch((reason: Error) => reason.message);
    expect(error).toContain("response.cloudaicompanionProject.id");
    expect(error).toContain("done");
    expect(error).not.toContain(TOKEN);
    expect(error).not.toContain(EMAIL);
  });

  it("names the onboarding stage when the operation is still pending past its deadline", async () => {
    const google = fakeCodeAssist({
      loads: [{ allowedTiers: [{ id: "g1-pro-tier", isDefault: true }] }],
      onboard: { name: "operations/onboard-2", done: false },
      operations: [{ name: "operations/onboard-2", done: false }],
    });
    const error = await google.adapter.importAccount().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(
      /still pending.*stage: onboardUser operation; tier id: g1-pro-tier/u,
    );
    expect(message).toContain(
      "tier ids: prod [current=none, paid=none, allowed=g1-pro-tier(default)]; daily [current=none, paid=none, allowed=g1-pro-tier(default)])",
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(EMAIL);
    expect(
      google.calls.filter((call) => call.method === "getOperation").length,
    ).toBeGreaterThan(1);
    expect(google.calls.filter((call) => call.method === "loadCodeAssist")).toHaveLength(2);
  });

  it.each([
    {
      name: "HTTP 500",
      failure: { status: 500 },
      original: "Gemini onboardUser failed with HTTP 500.",
    },
    {
      name: "a network error",
      failure: { error: new TypeError("fetch failed") },
      original: "fetch failed",
    },
  ])(
    "keeps the tier ids when the onboardUser request fails with $name",
    async ({ failure, original }) => {
      const google = fakeCodeAssist({
        loads: [
          {
            paidTier: { id: "g1-pro-tier" },
            allowedTiers: [{ id: "free-tier" }, { id: "g1-pro-tier", isDefault: true }],
          },
        ],
        onboardFailure: failure,
      });
      const error = await google.adapter.importAccount().then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message.startsWith(original)).toBe(true);
      expect(message).toContain("stage: onboardUser; tier id: g1-pro-tier");
      expect(message).toContain(
        "tier ids: prod [current=none, paid=g1-pro-tier, allowed=free-tier,g1-pro-tier(default)]; daily [current=none, paid=g1-pro-tier, allowed=free-tier,g1-pro-tier(default)])",
      );
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(EMAIL);
      expect(google.calls.map((call) => call.method)).toEqual([
        "loadCodeAssist",
        "loadCodeAssist",
        "onboardUser",
      ]);
    },
  );

  it("does not guess a tier when Google marks none as the default", async () => {
    const google = fakeCodeAssist({
      loads: [{ allowedTiers: [{ id: "free-tier" }, { id: "g1-pro-tier" }] }],
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /no project and tier.*stage: loadCodeAssist; tier ids: prod \[current=none, paid=none, allowed=free-tier,g1-pro-tier\]; daily \[current=none, paid=none, allowed=free-tier,g1-pro-tier\]/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist", "loadCodeAssist"]);
  });

  it("does not onboard to a paid tier that Google does not list as allowed", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          paidTier: { id: "g1-pro-tier" },
          allowedTiers: [{ id: "free-tier" }],
        },
      ],
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /no project for this account and offered no tier.*stage: loadCodeAssist; tier ids: prod \[current=none, paid=g1-pro-tier, allowed=free-tier\]; daily \[/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist", "loadCodeAssist"]);
  });

  it("does not onboard when Google sends an empty list of allowed tiers", async () => {
    const google = fakeCodeAssist({
      loads: [{ paidTier: { id: "g1-pro-tier" }, allowedTiers: [] }],
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /no project for this account and offered no tier.*stage: loadCodeAssist; tier ids: prod \[current=none, paid=g1-pro-tier, allowed=none\]; daily \[/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist", "loadCodeAssist"]);
  });

  it("adds an Ultra account the same way as before, with no onboarding", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          cloudaicompanionProject: "proj-ultra",
          paidTier: { name: "Google AI Ultra" },
        },
      ],
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      label: EMAIL,
      geminiProject: "proj-ultra",
      subscriptionType: "Google AI Ultra",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
  });

  const DAILY_ULTRA = {
    cloudaicompanionProject: "proj-daily-ultra",
    currentTier: { id: "standard-tier" },
    paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
  };

  it("imports an Antigravity sign-in from daily when prod offers only standard-tier and no project", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: { prod: [PROD_STANDARD_NO_PROJECT], daily: [DAILY_ULTRA] },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      email: EMAIL,
      geminiProject: "proj-daily-ultra",
      subscriptionType: "Google AI Ultra",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
    ]);
    expect(google.calls[0]?.body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
    for (const call of google.calls) {
      expect(JSON.stringify(call.body)).not.toContain(TOKEN);
      expect(JSON.stringify(call.body)).not.toContain(EMAIL);
    }
  });

  it.each([
    ["HTTP 500", { status: 500 }, "Gemini loadCodeAssist failed with HTTP 500."],
    ["network rejection", new TypeError("fetch failed"), "fetch failed"],
  ])("falls back to prod when the daily load fails, and names the daily failure (%s)", async (_name, failure, original) => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        prod: [{ currentTier: { id: "standard-tier" }, paidTier: { id: "ultra-tier", usesGcpTos: false }, allowedTiers: [{ id: "standard-tier", isDefault: true }, { id: "ultra-tier" }] }],
      },
      loadFailureByBase: { daily: failure as { status: number } | Error },
      onboard: { done: true, response: {} },
    });
    const message = await google.adapter.importAccount().then(
      () => null,
      (reason: Error) => reason.message,
    );
    expect(message).toContain("GOOGLE_CLOUD_PROJECT");
    expect(message).toContain(
      `tier ids: prod [current=standard-tier, paid=ultra-tier, allowed=standard-tier(default),ultra-tier]; daily [loadCodeAssist failed: ${original}]`,
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(EMAIL);
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("names the daily tier ids when the prod load fails after daily had no project", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: { daily: [DAILY_NO_PROJECT] },
      loadFailureByBase: { prod: { status: 503 } },
    });
    const caught = await google.adapter.importAccount().then(
      () => null,
      (reason: Error) => reason,
    );
    expect(caught?.message).toBe(
      "Gemini loadCodeAssist failed with HTTP 503. (stage: loadCodeAssist prod; tier ids: daily [current=free-tier, paid=none, allowed=none])",
    );
    expect(caught?.cause).toBeInstanceOf(Error);
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("includes the current, paid, and default tier ids in no-project errors", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
          currentTier: { id: "standard-tier" },
          paidTier: { id: "ultra-tier", usesGcpTos: false },
          allowedTiers: [{ id: "standard-tier", isDefault: true }],
        },
        {
          currentTier: { id: "standard-tier" },
          paidTier: { id: "ultra-tier", usesGcpTos: false },
          allowedTiers: [{ id: "standard-tier", isDefault: true }],
        },
      ],
      onboard: { done: true, response: {} },
    });
    const error = await google.adapter.importAccount().catch((reason: Error) => reason.message);
    expect(error).toContain(
      "current=standard-tier, paid=ultra-tier, allowed=standard-tier(default)",
    );
    expect(error).not.toContain(TOKEN);
    expect(error).not.toContain(EMAIL);
  });

  it("onboards a Pro account on prod when daily has no project", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [DAILY_NO_PROJECT],
        prod: [
          {
            paidTier: { id: "g1-pro-tier", usesGcpTos: false },
            allowedTiers: [
              { id: "standard-tier", isDefault: true },
              { id: "g1-pro-tier" },
            ],
          },
          {
            cloudaicompanionProject: "proj-pro",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro", usesGcpTos: false },
          },
        ],
      },
      onboard: {
        done: true,
        response: { cloudaicompanionProject: "proj-pro" },
      },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-pro",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("keeps the Pro no-project error, with both endpoints' tier ids", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [DAILY_NO_PROJECT],
        prod: [
          {
            paidTier: { id: "g1-pro-tier", usesGcpTos: false },
            allowedTiers: [
              { id: "standard-tier", isDefault: true },
              { id: "g1-pro-tier" },
            ],
          },
        ],
      },
      onboard: { done: true, response: {} },
    });
    const error = await google.adapter.importAccount().catch((reason: Error) => reason.message);
    expect(error).toContain("GOOGLE_CLOUD_PROJECT");
    expect(error).toContain(
      "tier ids: prod [current=none, paid=g1-pro-tier, allowed=standard-tier(default),g1-pro-tier]; daily [current=free-tier, paid=none, allowed=none]",
    );
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("takes a Pro account's project from daily without loading prod", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        prod: [
          {
            paidTier: { id: "g1-pro-tier", usesGcpTos: false },
            allowedTiers: [
              { id: "standard-tier", isDefault: true },
              { id: "g1-pro-tier" },
            ],
          },
        ],
        daily: [
          {
            cloudaicompanionProject: "proj-pro-daily",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro", usesGcpTos: false },
          },
        ],
      },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-pro-daily",
      subscriptionType: "Google AI Pro",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
    ]);
  });

  it.each([
    [{ id: null, name: "Pending" }, { id: "proj-object", name: "Project" }],
    [{ name: "Pending" }, "proj-object"],
  ])("reads daily project %j as missing and takes prod project %j", async (dailyProject, prodProject) => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [{ cloudaicompanionProject: dailyProject, paidTier: { id: "g1-ultra-tier" } }],
        prod: [{ cloudaicompanionProject: prodProject, paidTier: { id: "g1-ultra-tier" } }],
      },
    });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-object",
      subscriptionType: "g1-ultra-tier",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
    ]);
  });
});

describe("Gemini import dry run", () => {
  it("reports the daily project, tier ids and quota windows, and onboards nothing", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        prod: [PROD_STANDARD_NO_PROJECT],
        daily: [
          {
            cloudaicompanionProject: "proj-daily-ultra",
            currentTier: { id: "standard-tier" },
            paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
          },
        ],
      },
      quota: {
        buckets: [
          { bucketId: "gemini-4-neon", remainingFraction: 0.25 },
          { bucketId: "gemini-3-flash", remainingFraction: 0.5 },
        ],
      },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe).toEqual({
      provider: "gemini",
      credential: {
        source: "file",
        clientIdSuffix: "client",
        clientSource: "own",
        storedExpiresAt: Date.parse("2026-11-23T12:00:00Z"),
        accessTokenExpiresAt: expect.any(Number),
      },
      userAgent: AGY_AGENT,
      endpoints: [
        {
          endpoint: "daily",
          status: "answered",
          currentTier: "standard-tier",
          paidTier: "g1-ultra-tier",
          allowedTiers: [],
          ineligibleTiers: [],
          projectPresent: true,
        },
        {
          endpoint: "prod",
          status: "not-loaded",
          currentTier: null,
          paidTier: null,
          allowedTiers: [],
          ineligibleTiers: [],
          projectPresent: false,
        },
      ],
      wouldUse: { kind: "project", loadedFrom: "daily", servesOn: "daily" },
      quota: {
        kind: "answered",
        windows: 1,
        buckets: [
          {
            group: null,
            bucketId: "gemini-4-neon",
            displayName: null,
            remainingFraction: 0.25,
            resetTime: null,
            disabled: false,
            window: null,
            slot: "primary",
          },
          {
            group: null,
            bucketId: "gemini-3-flash",
            displayName: null,
            remainingFraction: 0.5,
            resetTime: null,
            disabled: false,
            window: null,
            slot: "skipped",
          },
        ],
      },
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["retrieveUserQuotaSummary", "daily"],
    ]);
    expect(JSON.stringify(probe)).not.toContain("proj-daily-ultra");
    expect(JSON.stringify(probe)).not.toContain(TOKEN);
    expect(JSON.stringify(probe)).not.toContain("refresh-onboard");
    expect(JSON.stringify(probe)).not.toContain("agy-secret");
  });

  it("reports the onboarding it would do without calling onboardUser", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: { daily: [DAILY_NO_PROJECT], prod: [PROD_STANDARD_NO_PROJECT] },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe).toMatchObject({
      endpoints: [
        { endpoint: "daily", status: "answered", currentTier: "free-tier", projectPresent: false },
        {
          endpoint: "prod",
          status: "answered",
          currentTier: null,
          paidTier: null,
          allowedTiers: [{ id: "standard-tier", isDefault: true }],
          projectPresent: false,
        },
      ],
      wouldUse: { kind: "onboard", endpoint: "prod", tierId: "standard-tier" },
      quota: { kind: "not-checked" },
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("dry-runs a prod-served account with prod's project and reads its quota summary from daily", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [PROD_SERVED_DAILY],
        prod: [PROD_SERVED_PROD],
      },
      quota: { buckets: [{ bucketId: "gemini-4-neon", remainingFraction: 0.5 }] },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe).toMatchObject({
      wouldUse: { kind: "project", loadedFrom: "prod", servesOn: "prod" },
      quota: { kind: "answered", windows: 1 },
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["retrieveUserQuotaSummary", "daily"],
    ]);
    expect(google.calls[2]?.body).toEqual({ project: "proj-gcp-prod" });
    expect(JSON.stringify(probe)).not.toContain("proj-gcp");
    expect(JSON.stringify(probe)).not.toContain(TOKEN);
  });

  it("reports each ineligible tier's id and reason code", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        daily: [DAILY_NO_PROJECT],
        prod: [
          {
            ...PROD_STANDARD_NO_PROJECT,
            ineligibleTiers: [
              { tierId: "free-tier", reasonCode: "INELIGIBLE_ACCOUNT", reasonMessage: "not for this account" },
              { tierId: "g1-ultra-tier", reasonCode: "VALIDATION_REQUIRED" },
            ],
          },
        ],
      },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe?.endpoints[1]?.ineligibleTiers).toEqual([
      { id: "free-tier", reasonCode: "INELIGIBLE_ACCOUNT" },
      { id: "g1-ultra-tier", reasonCode: "VALIDATION_REQUIRED" },
    ]);
    expect(JSON.stringify(probe)).not.toContain("not for this account");
  });

  it("reports a failed quota summary instead of throwing", async () => {
    const google = fakeCodeAssist({
      loads: [
        { cloudaicompanionProject: "proj-x", paidTier: { id: "g1-ultra-tier" } },
      ],
    });
    expect(await google.adapter.probeImport?.()).toMatchObject({
      wouldUse: { kind: "project", loadedFrom: "daily" },
      quota: { kind: "failed" },
    });
  });
});

const UNSUPPORTED_CLIENT_NO_PROJECT = {
  currentTier: null,
  paidTier: null,
  allowedTiers: [{ id: "standard-tier", isDefault: true }],
  ineligibleTiers: [{ tierId: "free-tier", reasonCode: "UNSUPPORTED_CLIENT" }],
};
const AGY_PAID_MANAGED = {
  cloudaicompanionProject: "proj-agy-managed",
  currentTier: { id: "standard-tier" },
  paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
};

describe("the Antigravity runtime User-Agent", () => {
  it.each([
    ["1.5.0", "darwin", "arm64", "antigravity/acp/1.5.0 (aidev_client; os_type=darwin; arch=arm64)"],
    ["1.6.2", "linux", "x64", "antigravity/acp/1.6.2 (aidev_client; os_type=linux; arch=amd64)"],
  ])("builds the agent for runtime %s on %s/%s", (version, platform, arch, expected) => {
    expect(antigravityRuntimeUserAgent(version, platform, arch)).toBe(expected);
    expect(expected).toMatch(AGY_REQUEST);
  });
});

describe("importing an Antigravity sign-in with the Antigravity request", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports the account Google answered UNSUPPORTED_CLIENT for, with no onboarding and no GOOGLE_CLOUD_PROJECT", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const google = fakeCodeAssist({
      loads: [AGY_PAID_MANAGED],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
    });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-agy-managed",
      geminiEndpoint: "daily",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
    ]);
    expect(google.calls[0]).toMatchObject({
      userAgent: AGY_AGENT,
      body: { metadata: { ideType: "ANTIGRAVITY" } },
    });
  });

  it("gets the UNSUPPORTED_CLIENT shape from the same fake when the request does not carry the Antigravity User-Agent", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const google = fakeCodeAssist({
      loads: [AGY_PAID_MANAGED],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      runtimeUserAgent: async () => "node",
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe?.endpoints).toMatchObject([
      {
        endpoint: "daily",
        currentTier: null,
        paidTier: null,
        allowedTiers: [{ id: "standard-tier", isDefault: true }],
        ineligibleTiers: [{ id: "free-tier", reasonCode: "UNSUPPORTED_CLIENT" }],
        projectPresent: false,
      },
      {
        endpoint: "prod",
        ineligibleTiers: [{ id: "free-tier", reasonCode: "UNSUPPORTED_CLIENT" }],
        projectPresent: false,
      },
    ]);
    expect(google.calls.every((call) => call.userAgent === "node")).toBe(true);
  });

  it("sends the Antigravity User-Agent on the dry run's load and quota summary calls", async () => {
    const google = fakeCodeAssist({
      loads: [AGY_PAID_MANAGED],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      quota: { buckets: [{ bucketId: "gemini-4-neon", remainingFraction: 0.5 }] },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe).toMatchObject({
      userAgent: AGY_AGENT,
      wouldUse: { kind: "project", loadedFrom: "daily", servesOn: "daily" },
      quota: { kind: "answered", windows: 1 },
    });
    expect(google.calls.map((call) => [call.method, call.userAgent])).toEqual([
      ["loadCodeAssist", AGY_AGENT],
      ["retrieveUserQuotaSummary", AGY_AGENT],
    ]);
  });

  it("fails with the runtime message and calls no Code Assist method when the runtime version cannot be read", async () => {
    const google = fakeCodeAssist({
      loads: [AGY_PAID_MANAGED],
      runtimeUserAgent: () =>
        Promise.reject(new Error("bb could not read the installed antigravity-acp runtime version")),
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /could not read the installed antigravity-acp runtime version/u,
    );
    expect(google.calls).toEqual([]);
  });

  it("onboards on daily with no project and takes the Google-managed project when daily still has none", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const script = {
      loads: [],
      loadsByBase: {
        daily: [UNSUPPORTED_CLIENT_NO_PROJECT, AGY_PAID_MANAGED],
        prod: [UNSUPPORTED_CLIENT_NO_PROJECT],
      },
      onboard: { done: true, response: { cloudaicompanionProject: { id: "proj-agy-managed" } } },
    };
    const dryRun = fakeCodeAssist(script);
    const probe = await dryRun.adapter.probeImport?.();
    expect(probe?.wouldUse).toEqual({ kind: "onboard", endpoint: "daily", tierId: "standard-tier" });
    expect(dryRun.calls.some((call) => call.method === "onboardUser")).toBe(false);
    const google = fakeCodeAssist(script);
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-agy-managed",
      geminiEndpoint: "daily",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["loadCodeAssist", "prod"],
      ["onboardUser", "daily"],
      ["loadCodeAssist", "daily"],
    ]);
    const onboard = google.calls.find((call) => call.method === "onboardUser");
    expect(onboard?.body).toEqual({
      tierId: "standard-tier",
      metadata: { ideType: "ANTIGRAVITY" },
    });
    expect(onboard?.userAgent).toBe(AGY_AGENT);
  });

  it("names the daily endpoint, not GOOGLE_CLOUD_PROJECT, when daily onboarding returns no project", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const google = fakeCodeAssist({
      loads: [UNSUPPORTED_CLIENT_NO_PROJECT],
      onboard: { done: true, response: {} },
    });
    const error = await google.adapter.importAccount().catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/onboarded standard-tier on the Antigravity daily endpoint but returned no Google-managed project/u);
    expect(String(error)).not.toContain("GOOGLE_CLOUD_PROJECT");
  });
});

const LIVE_AGY_DAILY = {
  cloudaicompanionProject: "proj-live-agy",
  currentTier: { id: "free-tier" },
  paidTier: { id: "g1-ultra-lite-tier" },
  allowedTiers: [{ id: "free-tier", isDefault: true }, { id: "standard-tier" }],
};
const ONE_WINDOW = {
  buckets: [
    { bucketId: "gemini-4-neon", remainingFraction: 0.5, resetTime: "2100-01-01T00:00:00Z" },
  ],
};
const RUNTIME_VERSION_FAILURE =
  "bb could not read the installed antigravity-acp runtime version (ACP initialize gave no agentInfo.version).";

const usageDirs: string[] = [];

async function usageStores() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-gemini-usage-agent-"));
  usageDirs.push(dataDir);
  const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
  const database = host.bb.storage.database();
  host.bb.storage.migrate(database, QUOTA_MIGRATIONS);
  return {
    accounts: new AccountStore(host.bb.storage.kv, path.join(dataDir, "secrets")),
    quotas: new QuotaStore(database),
  };
}

function pooledLiveAccount(): Account {
  return accountSchema.parse({
    id: randomUUID(),
    provider: "gemini",
    kind: "oauth",
    label: EMAIL,
    email: EMAIL,
    geminiProject: "proj-live-agy",
    geminiEndpoint: "daily",
    subscriptionType: "g1-ultra-lite-tier",
    rateLimitTier: null,
    enabled: true,
    priority: 0,
    createdAt: 0,
  });
}

async function storeLive(
  stores: Awaited<ReturnType<typeof usageStores>>,
  account: Account,
): Promise<Account> {
  const { id: _id, createdAt: _c, lastUsedAt: _l, lastUsedHostId: _h, ...input } =
    account;
  return stores.accounts.add(input, {
    kind: "oauth",
    accessToken: TOKEN,
    refreshToken: "refresh-onboard",
    expiresAt: null,
  });
}

function usageContext(
  stores: Awaited<ReturnType<typeof usageStores>>,
  account: Account,
  doFetch: typeof fetch,
  now: () => number,
): AdapterUsageContext {
  return {
    account,
    stillCurrent: () => true,
    freshSecret: async () => ({
      kind: "oauth",
      accessToken: TOKEN,
      refreshToken: "refresh-onboard",
      expiresAt: null,
    }),
    accounts: stores.accounts,
    quotas: stores.quotas,
    fetch: doFetch,
    now,
  };
}

describe("the live Antigravity daily shape", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    while (usageDirs.length > 0)
      await fs.rm(usageDirs.pop() ?? "", { recursive: true, force: true });
  });

  it("imports the daily project, serves on daily, onboards nothing and shows one usage window", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      quota: ONE_WINDOW,
    });
    expect(await google.adapter.importAccount()).toMatchObject({
      geminiProject: "proj-live-agy",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
    ]);
    const stores = await usageStores();
    const account = await storeLive(stores, pooledLiveAccount());
    await google.adapter.refreshUsage(usageContext(stores, account, google.fetch, Date.now));
    const quota = stores.quotas.get(account.id);
    expect(quota.error).toBeNull();
    expect(quota.limitWindows).toHaveLength(1);
    expect(google.calls.some((call) => call.method === "onboardUser")).toBe(false);
    expect(
      google.calls.some(
        (call) => call.base === "prod" && call.method !== "retrieveUserQuotaSummary",
      ),
    ).toBe(false);
    expect(google.calls.every((call) => call.userAgent === AGY_AGENT)).toBe(true);
    const dryRun = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      quota: ONE_WINDOW,
    });
    const probe = await dryRun.adapter.probeImport?.();
    expect(probe).toMatchObject({
      userAgent: AGY_AGENT,
      wouldUse: { kind: "project", loadedFrom: "daily", servesOn: "daily" },
      quota: { kind: "answered", windows: 1 },
    });
    expect(probe?.endpoints[0]).toMatchObject({
      endpoint: "daily",
      status: "answered",
      currentTier: "free-tier",
      paidTier: "g1-ultra-lite-tier",
      ineligibleTiers: [],
      projectPresent: true,
    });
  });

  it("answers the same account with the UNSUPPORTED_CLIENT shape when the request lacks the Antigravity User-Agent", async () => {
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      runtimeUserAgent: async () => "node",
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe?.endpoints[0]).toMatchObject({
      endpoint: "daily",
      ineligibleTiers: [{ id: "free-tier", reasonCode: "UNSUPPORTED_CLIENT" }],
      projectPresent: false,
    });
  });

  it("keeps refreshing usage with the last User-Agent it read when a later version read fails", async () => {
    let time = Date.parse("2026-11-23T18:00:00Z");
    let reads = 0;
    let failing = false;
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      unrecognizedClientLoad: UNSUPPORTED_CLIENT_NO_PROJECT,
      quota: ONE_WINDOW,
      now: () => time,
      runtimeUserAgent: async () => {
        reads += 1;
        if (failing) throw new Error(RUNTIME_VERSION_FAILURE);
        return AGY_AGENT;
      },
    });
    const stores = await usageStores();
    const account = await storeLive(stores, pooledLiveAccount());
    const context = usageContext(stores, account, google.fetch, () => time);
    await google.adapter.refreshUsage(context);
    failing = true;
    time += 11 * 60 * 1_000;
    google.calls.length = 0;
    await google.adapter.refreshUsage(context);
    expect(reads).toBe(2);
    const quota = stores.quotas.get(account.id);
    expect(quota.error).toBeNull();
    expect(quota.limitWindows).toHaveLength(1);
    expect(google.calls.map(({ method, userAgent }) => [method, userAgent])).toEqual([
      ["loadCodeAssist", AGY_AGENT],
      ["retrieveUserQuotaSummary", AGY_AGENT],
      ["retrieveUserQuotaSummary", AGY_AGENT],
    ]);
  });

  it("records a runtime_version error on the usage status and makes no Google call when no version was ever read", async () => {
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      quota: ONE_WINDOW,
      runtimeUserAgent: async () => {
        throw new Error(RUNTIME_VERSION_FAILURE);
      },
    });
    const stores = await usageStores();
    const account = await storeLive(stores, pooledLiveAccount());
    await expect(
      google.adapter.refreshUsage(usageContext(stores, account, google.fetch, Date.now)),
    ).rejects.toThrow(RUNTIME_VERSION_FAILURE);
    expect(stores.quotas.get(account.id).error).toBe(
      `Gemini usage refresh stopped (runtime_version): ${RUNTIME_VERSION_FAILURE}`,
    );
    expect(google.calls).toEqual([]);
  });
});

describe("Gemini Neon quota", () => {
  it("counts a Neon bucket as the primary window, so an exhausted Flash bucket does not block it", () => {
    const windows = geminiWindowsFromQuota(
      {
        buckets: [
          { bucketId: "gemini-3-flash", remainingFraction: 0 },
          { bucketId: "gemini-4-neon", remainingFraction: 0.5 },
        ],
      },
      1_000,
    );
    expect(windows).toEqual([
      {
        slot: "primary",
        windowMinutes: null,
        utilization: 0.5,
        resetAt: null,
        status: "allowed",
        observedAt: 1_000,
        source: "usage",
      },
    ]);
  });

  it("reads the remaining fraction, reset time and disabled flag of each bucket", () => {
    expect(
      geminiWindowsFromQuota(
        {
          groups: [
            {
              buckets: [
                {
                  bucketId: "gemini-4-neon",
                  displayName: "Gemini 4 Neon",
                  remainingFraction: 0.75,
                  remainingAmount: "75",
                  resetTime: "2026-11-23T15:00:00Z",
                },
                { bucketId: "gemini-3-flash", remainingFraction: 0, disabled: true },
              ],
            },
          ],
        },
        1_000,
      ),
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: null,
        utilization: 0.25,
        resetAt: Date.parse("2026-11-23T15:00:00Z"),
        status: "allowed",
        observedAt: 1_000,
        source: "usage",
      },
    ]);
  });

  it.each([null, "quota", { buckets: "none" }, { groups: [{ buckets: 3 }] }])(
    "reports no usage windows for an answer it cannot read (%j)",
    (payload) => {
      expect(geminiWindowsFromQuota(payload, 1_000)).toEqual([]);
    },
  );
});

const NOW = Date.parse("2026-11-25T12:00:00Z");
const QUOTA_READ_PREFIX = "Gemini usage refresh stopped (quota_read): ";
const QUOTA_READ_ERROR = /^Gemini usage refresh stopped \(quota_read\): ./u;
const FUTURE = "2100-01-01T00:00:00Z";
const bucket = (bucketId: string, remainingFraction: number) => ({
  bucketId,
  remainingFraction,
  resetTime: FUTURE,
});
const DAILY_WITHOUT_GEMINI = {
  groups: [
    {
      displayName: "Claude and GPT models",
      buckets: [bucket("3p-5h", 0.9), bucket("3p-weekly", 0.8)],
    },
  ],
};
const PROD_WITH_GEMINI = {
  groups: [
    {
      displayName: "Gemini models",
      buckets: [bucket("gemini-5h", 0.4), bucket("gemini-weekly", 0.7)],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [bucket("3p-5h", 0.6), bucket("3p-weekly", 0.95)],
    },
  ],
};

async function refreshed(
  google: ReturnType<typeof fakeCodeAssist>,
  account: Account = pooledLiveAccount(),
) {
  const stores = await usageStores();
  const stored = await storeLive(stores, account);
  await google.adapter.refreshUsage(
    usageContext(stores, stored, google.fetch, () => NOW),
  );
  return { stores, account: stored, quota: stores.quotas.get(stored.id) };
}

describe("Antigravity quota across the daily and prod endpoints", () => {
  afterEach(async () => {
    while (usageDirs.length > 0)
      await fs.rm(usageDirs.pop() ?? "", { recursive: true, force: true });
  });

  it("merges prod's Gemini group into a daily answer that lacks it, and the higher reading wins per bucket", async () => {
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      quotaByBase: { daily: DAILY_WITHOUT_GEMINI, prod: PROD_WITH_GEMINI },
    });
    const { stores, account, quota } = await refreshed(google);
    expect(quota.error).toBeNull();
    expect(
      quota.limitWindows.map((window) => [window.slot, window.utilization]),
    ).toEqual([
      ["primary", expect.closeTo(0.6)],
      ["secondary", expect.closeTo(0.3)],
    ]);
    const display = stores.quotas.modelWeekly(account.id);
    expect(display?.["Claude and GPT models · 5 hour"]?.utilization).toBeCloseTo(0.4);
    expect(display?.["Claude and GPT models · 7 day"]?.utilization).toBeCloseTo(0.2);
    expect(
      google.calls
        .filter((call) => call.method === "retrieveUserQuotaSummary")
        .map((call) => call.base)
        .sort(),
    ).toEqual(["daily", "prod"]);
  });

  it("keeps the other endpoint's buckets when one endpoint errors or answers empty", async () => {
    for (const script of [
      { quotaFailureByBase: { daily: 500 }, quotaByBase: { prod: ONE_WINDOW } },
      { quotaFailureByBase: { prod: 503 }, quotaByBase: { daily: ONE_WINDOW } },
      { quotaByBase: { daily: { buckets: [] }, prod: ONE_WINDOW } },
    ] as const) {
      const google = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], ...script });
      const { quota } = await refreshed(google);
      expect(quota.error).toBeNull();
      expect(quota.limitWindows).toHaveLength(1);
      expect(quota.limitWindows[0]?.utilization).toBeCloseTo(0.5);
    }
  });

  it("leaves the stored quota alone when every endpoint fails", async () => {
    const stores = await usageStores();
    const account = await storeLive(stores, pooledLiveAccount());
    const good = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
    await good.adapter.refreshUsage(
      usageContext(stores, account, good.fetch, () => NOW),
    );
    const failing = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      quotaFailureByBase: { daily: 500, prod: 500 },
    });
    await expect(
      failing.adapter.refreshUsage(
        usageContext(stores, account, failing.fetch, () => NOW),
      ),
    ).rejects.toThrow(/HTTP 500/u);
    expect(stores.quotas.get(account.id).limitWindows).toHaveLength(1);
  });

  it("keeps Claude and GPT buckets out of routing input and in the display model", async () => {
    expect(geminiWindowsFromQuota(DAILY_WITHOUT_GEMINI, NOW)).toEqual([]);
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      quotaByBase: { daily: DAILY_WITHOUT_GEMINI, prod: PROD_WITH_GEMINI },
    });
    const { quota } = await refreshed(google);
    expect(quota.limitWindows).toHaveLength(2);
    expect(quota.limitWindows.map((window) => window.utilization)).not.toContain(0.4);
    expect(quota.limitWindows.map((window) => window.utilization)).not.toContain(0.2);
  });
});

describe("Antigravity companion project for consumer accounts", () => {
  afterEach(async () => {
    while (usageDirs.length > 0)
      await fs.rm(usageDirs.pop() ?? "", { recursive: true, force: true });
  });

  const consumerAccount = () => ({
    ...pooledLiveAccount(),
    geminiProject: "aicode-consumers",
  });
  const NO_PROJECT_DAILY = {
    currentTier: { id: "free-tier" },
    paidTier: { id: "g1-ultra-lite-tier" },
  };

  it("uses the companion project loadCodeAssist returns instead of the consumer token project", async () => {
    const google = fakeCodeAssist({
      loads: [NO_PROJECT_DAILY],
      loadsByBase: {
        daily: [NO_PROJECT_DAILY],
        prod: [{ ...LIVE_AGY_DAILY, cloudaicompanionProject: "proj-companion" }],
      },
      quotaByProject: {
        "proj-companion": ONE_WINDOW,
        "aicode-consumers": { buckets: [] },
      },
    });
    const { quota } = await refreshed(google, consumerAccount());
    expect(quota.limitWindows).toHaveLength(1);
    const projects = google.calls
      .filter((call) => call.method === "retrieveUserQuotaSummary")
      .map((call) => call.body?.project);
    expect(new Set(projects)).toEqual(new Set(["proj-companion"]));
    const load = google.calls.find((call) => call.method === "loadCodeAssist");
    expect(load?.body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
  });

  it("prefers the other endpoint's companion over a non-consumer token project", async () => {
    const google = fakeCodeAssist({
      loads: [NO_PROJECT_DAILY],
      loadsByBase: {
        daily: [NO_PROJECT_DAILY],
        prod: [{ ...LIVE_AGY_DAILY, cloudaicompanionProject: "proj-companion" }],
      },
      quotaByProject: {
        "proj-companion": ONE_WINDOW,
        "proj-token": { buckets: [bucket("gemini-4-neon", 0.9)] },
      },
    });
    const { quota } = await refreshed(google, {
      ...pooledLiveAccount(),
      geminiProject: "proj-token",
    });
    expect(quota.limitWindows).toHaveLength(1);
    expect(quota.limitWindows[0]?.utilization).toBeCloseTo(0.5);
    expect(
      new Set(
        google.calls
          .filter((call) => call.method === "retrieveUserQuotaSummary")
          .map((call) => call.body?.project),
      ),
    ).toEqual(new Set(["proj-companion"]));
  });

  it("tries quota with no project and keeps its buckets when no project is stored and no endpoint returns a companion", async () => {
    const google = fakeCodeAssist({
      loads: [NO_PROJECT_DAILY],
      quotaByProject: { "": ONE_WINDOW },
    });
    const { geminiProject: _stored, ...withoutProject } = pooledLiveAccount();
    const { quota } = await refreshed(google, withoutProject);
    expect(quota.error).toBeNull();
    expect(quota.limitWindows).toHaveLength(1);
    expect(
      google.calls
        .filter((call) => call.method === "retrieveUserQuotaSummary")
        .every((call) => call.body?.project === undefined),
    ).toBe(true);
  });

  it("falls back from the companion project to the token project, then to none", async () => {
    const google = fakeCodeAssist({
      loads: [{ ...LIVE_AGY_DAILY, cloudaicompanionProject: "proj-companion" }],
      quotaByProject: {
        "proj-companion": { buckets: [] },
        "aicode-consumers": { buckets: [] },
        "": ONE_WINDOW,
      },
    });
    const { quota } = await refreshed(google, consumerAccount());
    expect(quota.limitWindows).toHaveLength(1);
    expect(
      [
        ...new Set(
          google.calls
            .filter((call) => call.method === "retrieveUserQuotaSummary")
            .map((call) => call.body?.project ?? "none"),
        ),
      ],
    ).toEqual(["proj-companion", "aicode-consumers", "none"]);
  });

  const ownAndOtherCompanions = (
    quotaByProject: Record<string, unknown>,
    mixed: {
      quotaByProjectBase?: Record<string, Partial<Record<"prod" | "daily", unknown>>>;
      quotaFailureByProjectBase?: Record<string, Partial<Record<"prod" | "daily", number>>>;
    } = {},
  ) =>
    fakeCodeAssist({
      ...mixed,
      loads: [LIVE_AGY_DAILY],
      loadsByBase: {
        daily: [{ ...LIVE_AGY_DAILY, cloudaicompanionProject: "proj-own" }],
        prod: [{ ...LIVE_AGY_DAILY, cloudaicompanionProject: "proj-other" }],
      },
      quotaByProject,
    });
  const quotaProjects = (google: ReturnType<typeof fakeCodeAssist>) => [
    ...new Set(
      google.calls
        .filter((call) => call.method === "retrieveUserQuotaSummary")
        .map((call) => call.body?.project ?? "none"),
    ),
  ];

  it("tries the other endpoint's companion when the own companion has no buckets, before the token project", async () => {
    const google = ownAndOtherCompanions({
      "proj-own": { buckets: [] },
      "proj-other": ONE_WINDOW,
      "proj-token": { buckets: [bucket("gemini-4-neon", 0.9)] },
    });
    const { quota } = await refreshed(google, {
      ...pooledLiveAccount(),
      geminiProject: "proj-token",
    });
    expect(quota.limitWindows).toHaveLength(1);
    expect(quota.limitWindows[0]?.utilization).toBeCloseTo(0.5);
    expect(quotaProjects(google)).toEqual(["proj-own", "proj-other"]);
  });

  it("guard: makes no extra load or quota call when the own companion already has buckets", async () => {
    const google = ownAndOtherCompanions({
      "proj-own": ONE_WINDOW,
      "proj-other": { buckets: [bucket("gemini-4-neon", 0.9)] },
      "proj-token": { buckets: [bucket("gemini-4-neon", 0.9)] },
    });
    const { quota } = await refreshed(google, {
      ...pooledLiveAccount(),
      geminiProject: "proj-token",
    });
    expect(quota.limitWindows).toHaveLength(1);
    expect(quotaProjects(google)).toEqual(["proj-own"]);
    expect(
      google.calls.filter((call) => call.method === "loadCodeAssist"),
    ).toHaveLength(1);
  });

  it("uses the stored project when the own and the other endpoint's companions both have no buckets", async () => {
    const google = ownAndOtherCompanions({
      "proj-own": { buckets: [] },
      "proj-other": { buckets: [] },
      "proj-token": ONE_WINDOW,
    });
    const { quota } = await refreshed(google, {
      ...pooledLiveAccount(),
      geminiProject: "proj-token",
    });
    expect(quota.limitWindows).toHaveLength(1);
    expect(quotaProjects(google)).toEqual([
      "proj-own",
      "proj-other",
      "proj-token",
    ]);
  });

  const storedAccount = async (
    stores: Awaited<ReturnType<typeof usageStores>>,
    geminiProject: string,
  ) => {
    const { id: _id, createdAt: _c, lastUsedAt: _l, lastUsedHostId: _h, ...input } =
      pooledLiveAccount();
    return stores.accounts.add(
      { ...input, geminiProject },
      { kind: "oauth", accessToken: TOKEN, refreshToken: "refresh-onboard", expiresAt: null },
    );
  };

  const THIRD_PARTY_ONLY = {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [bucket("3p-5h", 0.9), bucket("3p-weekly", 0.8)],
      },
    ],
  };

  it("keeps searching past a candidate with only Claude and GPT buckets, routes on the next candidate's Gemini windows and stores that project", async () => {
    const google = ownAndOtherCompanions({
      "proj-own": THIRD_PARTY_ONLY,
      "proj-other": ONE_WINDOW,
    });
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
    await google.adapter.refreshUsage(
      usageContext(stores, account, google.fetch, () => NOW),
    );
    const quota = stores.quotas.get(account.id);
    expect(quota.error).toBeNull();
    expect(quota.limitWindows).toHaveLength(1);
    expect(quota.limitWindows[0]?.utilization).toBeCloseTo(0.5);
    expect(quotaProjects(google)).toEqual(["proj-own", "proj-other"]);
    expect(setProject).toHaveBeenCalledTimes(1);
    expect(setProject).toHaveBeenCalledWith(
      account.id,
      "proj-other",
      undefined,
      account.createdAt,
    );
  });

  it("saves the Claude and GPT display, keeps the stored windows and project, and does not throw when no candidate has Gemini buckets", async () => {
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const good = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
    await good.adapter.refreshUsage(
      usageContext(stores, account, good.fetch, () => NOW),
    );
    const before = stores.quotas.get(account.id).limitWindows;
    expect(before).toHaveLength(1);
    const google = ownAndOtherCompanions({
      "proj-own": THIRD_PARTY_ONLY,
      "proj-other": THIRD_PARTY_ONLY,
      "proj-token": THIRD_PARTY_ONLY,
      "proj-live-agy": THIRD_PARTY_ONLY,
      "": THIRD_PARTY_ONLY,
    });
    const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
    const current = (await stores.accounts.get(account.id)) ?? account;
    await google.adapter.refreshUsage(
      usageContext(stores, current, google.fetch, () => NOW),
    );
    expect(stores.quotas.get(account.id).limitWindows).toEqual(before);
    expect(setProject).not.toHaveBeenCalled();
    expect(Object.keys(stores.quotas.modelWeekly(account.id) ?? {})).toHaveLength(2);
    expect(quotaProjects(google)).toEqual(["proj-own", "proj-other", "proj-live-agy", "none"]);
  });

  it("applies the no-project answer's Gemini windows when every project returns only Claude and GPT buckets, and leaves the stored project alone", async () => {
    const google = ownAndOtherCompanions({
      "proj-own": THIRD_PARTY_ONLY,
      "proj-other": THIRD_PARTY_ONLY,
      "proj-token": THIRD_PARTY_ONLY,
      "": { ...ONE_WINDOW, groups: THIRD_PARTY_ONLY.groups },
    });
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
    await google.adapter.refreshUsage(
      usageContext(stores, account, google.fetch, () => NOW),
    );
    const quota = stores.quotas.get(account.id);
    expect(quota.error).toBeNull();
    expect(quota.limitWindows).toHaveLength(1);
    expect(quota.limitWindows[0]?.utilization).toBeCloseTo(0.5);
    expect(Object.keys(stores.quotas.modelWeekly(account.id) ?? {})).toHaveLength(2);
    expect(quotaProjects(google)).toEqual(["proj-own", "proj-other", "proj-token", "none"]);
    expect(setProject).not.toHaveBeenCalled();
    expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-token");
  });

  it("completes a Claude and GPT only refresh without a Gemini reading: clears a recoverable error, keeps the stored restriction, windows, observedAt and project", async () => {
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const good = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
    await good.adapter.refreshUsage(
      usageContext(stores, account, good.fetch, () => NOW),
    );
    const seeded = stores.quotas.get(account.id);
    const storedProject = (await stores.accounts.get(account.id))?.geminiProject;
    expect(storedProject).toBe("proj-live-agy");
    expect(seeded.limitWindows).toHaveLength(1);
    stores.quotas.put({
      ...seeded,
      error: "OAuth refresh failed with HTTP 500.",
      usageRestriction: { reason: "quota_exhausted", resetAt: NOW + 1 },
    });
    const google = ownAndOtherCompanions({
      "proj-own": THIRD_PARTY_ONLY,
      "proj-other": THIRD_PARTY_ONLY,
      "proj-token": THIRD_PARTY_ONLY,
      "proj-live-agy": THIRD_PARTY_ONLY,
      "": THIRD_PARTY_ONLY,
    });
    const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
    await google.adapter.refreshUsage(
      usageContext(
        stores,
        (await stores.accounts.get(account.id)) ?? account,
        google.fetch,
        () => NOW + 60_000,
      ),
    );
    const quota = stores.quotas.get(account.id);
    expect(quota.error).toBeNull();
    expect(quota.usageRestriction).toEqual({ reason: "quota_exhausted", resetAt: NOW + 1 });
    expect(quota.observedAt).toBe(seeded.observedAt);
    expect(quota.limitWindows).toEqual(seeded.limitWindows);
    expect(Object.keys(stores.quotas.modelWeekly(account.id) ?? {})).toHaveLength(2);
    expect(setProject).not.toHaveBeenCalled();
    expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
  });

  type CandidateState =
    | "fails"
    | "empty"
    | "third-party"
    | "gemini"
    | "both"
    | "mixed"
    | "mixed-3p"
    | "unreadable"
    | "mixed-unreadable";
  const CANDIDATE_STATES: CandidateState[] = [
    "fails",
    "empty",
    "third-party",
    "gemini",
    "both",
    "mixed",
    "mixed-3p",
    "unreadable",
    "mixed-unreadable",
  ];
  const matrixPayload = (state: CandidateState, gemini: number, thirdParty: number) => {
    const geminiBuckets = [bucket("gemini-4-neon", gemini)];
    const groups = [
      {
        displayName: "Claude and GPT models",
        buckets: [bucket("3p-5h", thirdParty), bucket("3p-weekly", thirdParty - 0.1)],
      },
    ];
    if (state === "empty" || state === "mixed") return { buckets: [] };
    if (state === "third-party" || state === "mixed-3p") return { groups };
    if (state === "gemini") return { buckets: geminiBuckets };
    if (state === "both") return { buckets: geminiBuckets, groups };
    if (state === "unreadable") return { buckets: "none" };
    return undefined;
  };
  const matrixRows = CANDIDATE_STATES.flatMap((a) =>
    CANDIDATE_STATES.map((b) => [a, b] as const),
  );

  it.each(matrixRows)(
    "refreshes with own companion %s and other companion %s: routing from the first Gemini candidate, 3p display kept, project and error settled",
    async (a, b) => {
      const stores = await usageStores();
      const account = await storedAccount(stores, "proj-token");
      const seed = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
      await seed.adapter.refreshUsage(usageContext(stores, account, seed.fetch, () => NOW));
      const seeded = stores.quotas.get(account.id);
      const storedProject = (await stores.accounts.get(account.id))?.geminiProject;
      const seededRestriction = {
        reason: "quota_exhausted" as const,
        resetAt: NOW + 3_600_000,
      };
      stores.quotas.put({
        ...seeded,
        error: "OAuth refresh failed with HTTP 500.",
        usageRestriction: seededRestriction,
      });
      const staleDisplay = {
        "Stale 3p": { utilization: 0.77, resetAt: null, status: null, observedAt: NOW, source: "usage" as const },
      };
      stores.quotas.putModelWeekly(account.id, staleDisplay);
      const byProject: Record<string, unknown> = {
        "proj-token": { buckets: [] },
        "proj-live-agy": { buckets: [] },
        "": { buckets: [] },
      };
      const mixedAnswers: {
        quotaByProjectBase: Record<string, Partial<Record<"prod" | "daily", unknown>>>;
        quotaFailureByProjectBase: Record<string, Partial<Record<"prod" | "daily", number>>>;
      } = { quotaByProjectBase: {}, quotaFailureByProjectBase: {} };
      for (const [project, state, gemini, thirdParty] of [
        ["proj-own", a, 0.3, 0.9],
        ["proj-other", b, 0.1, 0.6],
      ] as const) {
        const payload = matrixPayload(state, gemini, thirdParty);
        if (state === "mixed" || state === "mixed-3p") {
          mixedAnswers.quotaFailureByProjectBase[project] = { daily: 503 };
          mixedAnswers.quotaByProjectBase[project] = { prod: payload };
        } else if (state === "mixed-unreadable") {
          mixedAnswers.quotaByProjectBase[project] = {
            daily: { buckets: "none" },
            prod: { buckets: [] },
          };
        } else if (payload !== undefined) byProject[project] = payload;
      }
      const google = ownAndOtherCompanions(byProject, mixedAnswers);
      const live = (await stores.accounts.get(account.id)) ?? account;
      const run = google.adapter.refreshUsage(
        usageContext(stores, live, google.fetch, () => NOW + 60_000),
      );
      const hasGemini = (state: CandidateState) => state === "gemini" || state === "both";
      const hasThirdParty = (state: CandidateState) =>
        state === "third-party" || state === "both" || state === "mixed-3p";
      const rejects = (state: CandidateState) =>
        state === "fails" ||
        state === "mixed" ||
        state === "mixed-3p" ||
        state === "unreadable" ||
        state === "mixed-unreadable";
      const winner = hasGemini(a) ? "a" : hasGemini(b) ? "b" : null;
      const visitedRejected = rejects(a) || (!hasGemini(a) && rejects(b));
      if (winner === null && visitedRejected) {
        await expect(run).rejects.toBeDefined();
        const kept = stores.quotas.get(account.id);
        expect(kept.limitWindows).toEqual(seeded.limitWindows);
        expect(kept.observedAt).toBe(seeded.observedAt);
        expect(kept.error).toMatch(QUOTA_READ_ERROR);
        expect(kept.usageRestriction).toEqual(seededRestriction);
        expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
        expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
        return;
      }
      await run;
      const quota = stores.quotas.get(account.id);
      expect(quota.error).toBeNull();
      const thirdPartyOnly = winner === null && (hasThirdParty(a) || hasThirdParty(b));
      expect(quota.observedAt).toBe(thirdPartyOnly ? seeded.observedAt : NOW + 60_000);
      expect(quota.usageRestriction).toEqual(
        winner === null ? seededRestriction : null,
      );
      if (winner === null)
        expect(quota.limitWindows).toEqual(
          hasThirdParty(a) || hasThirdParty(b) ? seeded.limitWindows : [],
        );
      else {
        expect(quota.limitWindows).toHaveLength(1);
        expect(quota.limitWindows[0]?.utilization).toBeCloseTo(winner === "a" ? 0.7 : 0.9);
      }
      const display = stores.quotas.modelWeekly(account.id) ?? {};
      expect(Object.keys(display)).not.toContain("Stale 3p");
      const winnerState = winner === "a" ? a : winner === "b" ? b : null;
      const displaySource =
        winnerState !== null && hasThirdParty(winnerState)
          ? winner
          : hasThirdParty(a)
            ? "a"
            : winner !== "a" && hasThirdParty(b)
              ? "b"
              : null;
      if (displaySource === null) expect(Object.keys(display)).toHaveLength(0);
      else {
        expect(Object.keys(display)).toHaveLength(2);
        const fiveHour = Object.values(display).find((row) => row.utilization !== null && Math.abs(row.utilization - (displaySource === "a" ? 0.1 : 0.4)) < 1e-6);
        expect(fiveHour).toBeDefined();
      }
      const expectedProject = winner === "a" ? "proj-own" : winner === "b" ? "proj-other" : storedProject;
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe(expectedProject);
    },
  );

  const abortingContext = (
    stores: Awaited<ReturnType<typeof usageStores>>,
    account: Account,
    google: ReturnType<typeof fakeCodeAssist>,
    controller: AbortController,
    now: () => number,
  ): AdapterUsageContext => ({
    ...usageContext(stores, account, google.fetch, now),
    signal: controller.signal,
  });
  const seededForCommit = async () => {
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const seed = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
    await seed.adapter.refreshUsage(usageContext(stores, account, seed.fetch, () => NOW));
    const seeded = stores.quotas.get(account.id);
    const storedProject = (await stores.accounts.get(account.id))?.geminiProject;
    const live = (await stores.accounts.get(account.id)) ?? account;
    const google = ownAndOtherCompanions({
      "proj-own": { buckets: [bucket("gemini-4-neon", 0.1)] },
    });
    return { stores, account: live, seeded, storedProject, google };
  };

  it("records no error when the refresh is cancelled during the quota read, since a cancel is not a failed read", async () => {
    const { stores, account, seeded, google } = await seededForCommit();
    stores.quotas.put({ ...seeded, error: "OAuth refresh failed with HTTP 500." });
    const controller = new AbortController();
    const abortingFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith(":retrieveUserQuotaSummary")) controller.abort();
      return google.fetch(input, init);
    };
    await expect(
      google.adapter.refreshUsage({
        ...abortingContext(stores, account, google, controller, () => NOW + 60_000),
        fetch: abortingFetch,
      }),
    ).rejects.toBeDefined();
    const kept = stores.quotas.get(account.id);
    expect(kept.error).toBe("OAuth refresh failed with HTTP 500.");
    expect(kept.limitWindows).toEqual(seeded.limitWindows);
    expect(kept.observedAt).toBe(seeded.observedAt);
  });

  const RECOVERABLE_ERRORS = [
    ["quota_read", `${QUOTA_READ_PREFIX}old read failure`],
    ["runtime_version", "Gemini usage refresh stopped (runtime_version): old lookup failure"],
  ] as const;

  const seededWithError = async (seedError: string) => {
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-token");
    const google = fakeCodeAssist({
      loads: [LIVE_AGY_DAILY],
      quota: ONE_WINDOW,
    });
    await google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW));
    stores.quotas.put({ ...stores.quotas.get(account.id), error: seedError });
    const live = (await stores.accounts.get(account.id)) ?? account;
    return {
      stores,
      account: live,
      google,
      before: stores.quotas.get(account.id),
      accountBefore: live,
    };
  };

  it.each(RECOVERABLE_ERRORS)(
    "keeps a seeded %s error and every quota field when the refresh is cancelled during the quota read",
    async (_kind, seedError) => {
      const { stores, account, google, before } = await seededWithError(seedError);
      const controller = new AbortController();
      const abortingFetch: typeof fetch = async (input, init) => {
        if (String(input).endsWith(":retrieveUserQuotaSummary")) controller.abort();
        return google.fetch(input, init);
      };
      await expect(
        google.adapter.refreshUsage({
          ...abortingContext(stores, account, google, controller, () => NOW + 60_000),
          fetch: abortingFetch,
        }),
      ).rejects.toBeDefined();
      expect(stores.quotas.get(account.id)).toEqual(before);
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe(
        account.geminiProject,
      );
    },
  );

  it.each(RECOVERABLE_ERRORS)(
    "keeps a seeded %s error and every quota field when the credential refresh fails, and records no quota_read error",
    async (_kind, seedError) => {
      const { stores, account, google, before } = await seededWithError(seedError);
      await expect(
        google.adapter.refreshUsage({
          ...usageContext(stores, account, google.fetch, () => NOW + 60_000),
          freshSecret: async () => {
            throw new Error("OAuth refresh failed with HTTP 401.");
          },
        }),
      ).rejects.toThrow("OAuth refresh failed with HTTP 401.");
      expect(stores.quotas.get(account.id)).toEqual(before);
    },
  );

  it.each(RECOVERABLE_ERRORS)(
    "records a runtime_version error and moves nothing else when the version lookup fails over a seeded %s error",
    async (_kind, seedError) => {
      const { stores, account, before } = await seededWithError(seedError);
      const failing = fakeCodeAssist({
        loads: [LIVE_AGY_DAILY],
        quota: ONE_WINDOW,
        runtimeUserAgent: async () => {
          throw new Error(RUNTIME_VERSION_FAILURE);
        },
      });
      await expect(
        failing.adapter.refreshUsage(usageContext(stores, account, failing.fetch, () => NOW + 60_000)),
      ).rejects.toThrow(RUNTIME_VERSION_FAILURE);
      expect(failing.calls).toEqual([]);
      expect(stores.quotas.get(account.id)).toEqual({
        ...before,
        error: `Gemini usage refresh stopped (runtime_version): ${RUNTIME_VERSION_FAILURE}`,
      });
    },
  );

  it.each(RECOVERABLE_ERRORS)(
    "records a quota_read error and leaves the endpoint, tier, project and quota alone when loadCodeAssist fails over a seeded %s error",
    async (_kind, seedError) => {
      const { stores, account, google, before } = await seededWithError(seedError);
      const failingFetch: typeof fetch = async (input, init) =>
        String(input).endsWith(":loadCodeAssist")
          ? new Response("{}", { status: 503 })
          : google.fetch(input, init);
      await expect(
        google.adapter.refreshUsage({
          ...usageContext(stores, account, failingFetch, () => NOW + 60_000),
        }),
      ).rejects.toBeDefined();
      const after = stores.quotas.get(account.id);
      expect(after.error?.startsWith(QUOTA_READ_PREFIX)).toBe(true);
      expect({ ...after, error: null }).toEqual({ ...before, error: null });
      const stored = await stores.accounts.get(account.id);
      expect(stored?.geminiEndpoint).toBe(account.geminiEndpoint);
      expect(stored?.subscriptionType).toBe(account.subscriptionType);
      expect(stored?.geminiProject).toBe(account.geminiProject);
    },
  );

  it("never mixes the new project with the old windows when the refresh is aborted right after the project commits", async () => {
    const { stores, account, seeded, google } = await seededForCommit();
    const controller = new AbortController();
    const original = stores.accounts.setGeminiProject.bind(stores.accounts);
    vi.spyOn(stores.accounts, "setGeminiProject").mockImplementation(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    await google.adapter
      .refreshUsage(abortingContext(stores, account, google, controller, () => NOW + 60_000))
      .catch(() => undefined);
    const project = (await stores.accounts.get(account.id))?.geminiProject;
    const utilization = stores.quotas.get(account.id).limitWindows[0]?.utilization;
    expect([project, utilization?.toFixed(2)]).toEqual(["proj-own", "0.90"]);
    expect(seeded.limitWindows[0]?.utilization).toBeCloseTo(0.5);
  });

  it("commits the windows and the project together when the abort lands as the project write starts", async () => {
    const { stores, account, google } = await seededForCommit();
    const controller = new AbortController();
    const original = stores.accounts.setGeminiProject.bind(stores.accounts);
    vi.spyOn(stores.accounts, "setGeminiProject").mockImplementation(async (...args) => {
      controller.abort();
      return original(...args);
    });
    await google.adapter
      .refreshUsage(abortingContext(stores, account, google, controller, () => NOW + 60_000))
      .catch(() => undefined);
    const project = (await stores.accounts.get(account.id))?.geminiProject;
    const utilization = stores.quotas.get(account.id).limitWindows[0]?.utilization;
    expect([project, utilization?.toFixed(2)]).toEqual(["proj-own", "0.90"]);
  });

  it("changes neither the project nor the quota when the abort lands before the commit point", async () => {
    const { stores, account, seeded, storedProject, google } = await seededForCommit();
    const controller = new AbortController();
    const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
    let calls = 0;
    const result = await google.adapter
      .refreshUsage(
        abortingContext(stores, account, google, controller, () => {
          calls += 1;
          controller.abort();
          return NOW + 60_000;
        }),
      )
      .catch((error: unknown) => error);
    expect(calls).toBeGreaterThan(0);
    expect(result).toBeInstanceOf(Error);
    expect(setProject).not.toHaveBeenCalled();
    expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
    expect(stores.quotas.get(account.id).limitWindows).toEqual(seeded.limitWindows);
    expect(stores.quotas.get(account.id).observedAt).toBe(seeded.observedAt);
  });

  it("keeps the old project and the old quota together when the project write fails, and the next refresh repairs both", async () => {
    const { stores, account, seeded, storedProject, google } = await seededForCommit();
    const spy = vi
      .spyOn(stores.accounts, "setGeminiProject")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
    ).rejects.toThrow("disk full");
    expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
    expect(stores.quotas.get(account.id).limitWindows).toEqual(seeded.limitWindows);
    expect(stores.quotas.get(account.id).observedAt).toBe(seeded.observedAt);
    expect(stores.quotas.get(account.id).error).toBe(
      `${QUOTA_READ_PREFIX}disk full`,
    );
    spy.mockRestore();
    await google.adapter.refreshUsage(
      usageContext(stores, (await stores.accounts.get(account.id)) ?? account, google.fetch, () => NOW + 120_000),
    );
    expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-own");
    expect(stores.quotas.get(account.id).limitWindows[0]?.utilization).toBeCloseTo(0.9);
  });

  describe("the commit step is all-or-nothing", () => {
    const COMMIT_PREFIX = "Gemini usage refresh stopped (commit): ";
    const WINNER_WITH_THIRD_PARTY = {
      buckets: [bucket("gemini-4-neon", 0.1)],
      groups: [
        {
          displayName: "Claude and GPT models",
          buckets: [bucket("3p-5h", 0.9), bucket("3p-weekly", 0.8)],
        },
      ],
    };
    const seededForRollback = async () => {
      const stores = await usageStores();
      const account = await storedAccount(stores, "proj-token");
      const seed = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
      await seed.adapter.refreshUsage(usageContext(stores, account, seed.fetch, () => NOW));
      const staleDisplay = {
        "Stale 3p": { utilization: 0.77, resetAt: null, status: null, observedAt: NOW, source: "usage" as const },
      };
      stores.quotas.putModelWeekly(account.id, staleDisplay);
      const live = (await stores.accounts.get(account.id)) ?? account;
      const google = ownAndOtherCompanions({ "proj-own": WINNER_WITH_THIRD_PARTY });
      return {
        stores,
        account: live,
        google,
        staleDisplay,
        seeded: stores.quotas.get(account.id),
        storedProject: live.geminiProject,
      };
    };

    const failCommitPut = (stores: Awaited<ReturnType<typeof usageStores>>) => {
      const real = stores.quotas.put.bind(stores.quotas);
      return vi
        .spyOn(stores.quotas, "put")
        .mockImplementationOnce(real)
        .mockImplementationOnce(() => {
          throw new Error("disk full");
        });
    };

    it.each(["putModelWeekly", "put"] as const)(
      "restores the old project and keeps the old quota and 3p display when %s throws after the project changed",
      async (failing) => {
        const { stores, account, google, staleDisplay, seeded, storedProject } = await seededForRollback();
        expect(storedProject).not.toBe("proj-own");
        const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
        if (failing === "put") failCommitPut(stores);
        else
          vi.spyOn(stores.quotas, "putModelWeekly").mockImplementationOnce(() => {
            throw new Error("disk full");
          });
        await expect(
          google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
        ).rejects.toThrow("disk full");
        expect(setProject.mock.calls.map((call) => call[1])).toEqual(["proj-own", storedProject]);
        expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
        expect(stores.quotas.get(account.id)).toEqual({
          ...seeded,
          error: `${QUOTA_READ_PREFIX}disk full`,
        });
        expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
      },
    );

    it("restores a project that was unset before the refresh", async () => {
      const { stores, google } = await seededForRollback();
      const bare = await storedAccount(stores, "proj-token");
      await stores.accounts.setGeminiProject(bare.id, undefined);
      const account = (await stores.accounts.get(bare.id)) ?? bare;
      expect(account.geminiProject).toBeUndefined();
      failCommitPut(stores);
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
      ).rejects.toThrow("disk full");
      expect((await stores.accounts.get(account.id))?.geminiProject).toBeUndefined();
    });

    it("writes nothing, not even the project, when the reading does not validate", async () => {
      const { stores, account, google, staleDisplay, seeded, storedProject } = await seededForRollback();
      const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
      const putDisplay = vi.spyOn(stores.quotas, "putModelWeekly");
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000.5)),
      ).rejects.toBeDefined();
      expect(setProject).not.toHaveBeenCalled();
      expect(putDisplay).not.toHaveBeenCalled();
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
      const kept = stores.quotas.get(account.id);
      expect(kept.error).toMatch(QUOTA_READ_ERROR);
      expect({ ...kept, error: null }).toEqual({ ...seeded, error: null });
      expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
    });

    it("writes no quota when only the 3p display does not validate", async () => {
      const { stores, account, staleDisplay, seeded } = await seededForRollback();
      const google = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: DAILY_WITHOUT_GEMINI });
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000.5)),
      ).rejects.toBeDefined();
      const kept = stores.quotas.get(account.id);
      expect(kept.error).toMatch(QUOTA_READ_ERROR);
      expect({ ...kept, error: null }).toEqual({ ...seeded, error: null });
      expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
    });

    it("records a blocking commit error when the restore fails too, and the next successful commit clears it", async () => {
      const { stores, account, google, staleDisplay, seeded, storedProject } = await seededForRollback();
      const original = stores.accounts.setGeminiProject.bind(stores.accounts);
      const setProject = vi
        .spyOn(stores.accounts, "setGeminiProject")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("restore failed"));
      failCommitPut(stores);
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
      ).rejects.toThrow("disk full; the previous project could not be restored: restore failed");
      expect(setProject).toHaveBeenCalledTimes(2);
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-own");
      const stored = stores.quotas.get(account.id);
      expect(stored.error).toBe(`${COMMIT_PREFIX}project change to proj-own pending`);
      expect({ ...stored, error: null }).toEqual({ ...seeded, error: null });
      expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
      expect(storedProject).not.toBe("proj-own");
      expect(google.adapter.isTransientUsageError?.(stored.error ?? "")).toBe(true);
      expect(google.adapter.isNonBlockingUsageError?.(stored.error ?? "")).toBe(false);
      setProject.mockRestore();
      await google.adapter.refreshUsage(
        usageContext(stores, (await stores.accounts.get(account.id)) ?? account, google.fetch, () => NOW + 120_000),
      );
      expect(stores.quotas.get(account.id).error).toBeNull();
      expect(stores.quotas.get(account.id).limitWindows[0]?.utilization).toBeCloseTo(0.9);
      expect(Object.keys(stores.quotas.modelWeekly(account.id) ?? {})).toHaveLength(2);
    });

    it("keeps the marker when the commit, the restore and every later write fail, and the next successful refresh clears it", async () => {
      const { stores, account, google, staleDisplay, seeded } = await seededForRollback();
      const real = stores.quotas.put.bind(stores.quotas);
      let puts = 0;
      vi.spyOn(stores.quotas, "put").mockImplementation((value) => {
        puts += 1;
        if (puts > 1) throw new Error("disk full");
        return real(value);
      });
      const original = stores.accounts.setGeminiProject.bind(stores.accounts);
      vi.spyOn(stores.accounts, "setGeminiProject")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("restore failed"));
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
      ).rejects.toThrow("restore failed");
      vi.restoreAllMocks();
      const stored = stores.quotas.get(account.id);
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-own");
      expect(stored.error).toBe(`${COMMIT_PREFIX}project change to proj-own pending`);
      expect({ ...stored, error: null }).toEqual({ ...seeded, error: null });
      expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
      expect(google.adapter.isTransientUsageError?.(stored.error ?? "")).toBe(true);
      expect(google.adapter.isNonBlockingUsageError?.(stored.error ?? "")).toBe(false);
      await google.adapter.refreshUsage(
        usageContext(stores, (await stores.accounts.get(account.id)) ?? account, google.fetch, () => NOW + 120_000),
      );
      expect(stores.quotas.get(account.id).error).toBeNull();
    });

    it("leaves the new project beside the old quota with the marker stored when the process dies after the project write", async () => {
      const { stores, account, google, seeded } = await seededForRollback();
      vi.spyOn(stores.quotas, "commitReading").mockImplementation(() => {
        throw new Error("process died");
      });
      const original = stores.accounts.setGeminiProject.bind(stores.accounts);
      vi.spyOn(stores.accounts, "setGeminiProject")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("process died"));
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
      ).rejects.toThrow("process died");
      vi.restoreAllMocks();
      const stored = stores.quotas.get(account.id);
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-own");
      expect(stored.error?.startsWith(COMMIT_PREFIX)).toBe(true);
      expect({ ...stored, error: null }).toEqual({ ...seeded, error: null });
    });

    it("changes nothing and still serves the old project when the marker write itself fails", async () => {
      const { stores, account, google, staleDisplay, seeded, storedProject } = await seededForRollback();
      const setProject = vi.spyOn(stores.accounts, "setGeminiProject");
      vi.spyOn(stores.quotas, "put").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      await expect(
        google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
      ).rejects.toThrow("disk full");
      expect(setProject).not.toHaveBeenCalled();
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
      expect(stores.quotas.get(account.id)).toEqual({ ...seeded, error: `${QUOTA_READ_PREFIX}disk full` });
      expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
    });

    it("leaves no marker after a successful project change", async () => {
      const { stores, account, google } = await seededForRollback();
      const put = vi.spyOn(stores.quotas, "put");
      await google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000));
      expect(put.mock.calls.map((call) => call[0].error)).toEqual([`${COMMIT_PREFIX}project change to proj-own pending`, null]);
      expect(stores.quotas.get(account.id).error).toBeNull();
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe("proj-own");
      expect(stores.quotas.get(account.id).usageRestriction ?? null).toBeNull();
    });

    it("writes no marker when the project does not change", async () => {
      const { stores, account, storedProject } = await seededForRollback();
      const same = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
      const put = vi.spyOn(stores.quotas, "put");
      await same.adapter.refreshUsage(usageContext(stores, account, same.fetch, () => NOW + 60_000));
      expect(put.mock.calls.map((call) => call[0].error)).toEqual([null]);
      expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
    });

    it.each([
      ["a failed load", "quota_read"],
      ["a failed version lookup", "runtime_version"],
    ] as const)(
      "changes nothing and surfaces the write error when recording the error of %s throws",
      async (_name, kind) => {
        const { stores, account, staleDisplay, seeded, storedProject } = await seededForRollback();
        const google =
          kind === "quota_read"
            ? fakeCodeAssist({ loads: [], loadFailureByBase: { daily: { status: 503 } }, quota: ONE_WINDOW })
            : fakeCodeAssist({
                loads: [LIVE_AGY_DAILY],
                quota: ONE_WINDOW,
                runtimeUserAgent: () => Promise.reject(new Error(RUNTIME_VERSION_FAILURE)),
              });
        vi.spyOn(stores.quotas, "put").mockImplementationOnce(() => {
          throw new Error("error record failed");
        });
        await expect(
          google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
        ).rejects.toThrow("error record failed");
        expect(stores.quotas.get(account.id)).toEqual(seeded);
        expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
        expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
      },
    );

    it.each([
      ["endpoint", "setGeminiEndpoint", [{ ...LIVE_AGY_DAILY, paidTier: { id: "enterprise-tier", usesGcpTos: true } }]],
      ["tier", "setSubscriptionType", [{ ...LIVE_AGY_DAILY, paidTier: { id: "g1-ultra-tier" } }]],
    ] as const)(
      "stores the %s error and writes no quota, display or project when the %s write throws",
      async (_name, method, script) => {
        const { stores, account, staleDisplay, seeded, storedProject } = await seededForRollback();
        const google = fakeCodeAssist({ loads: [...script], quota: ONE_WINDOW });
        vi.spyOn(stores.accounts, method).mockRejectedValueOnce(new Error("disk full"));
        await expect(
          google.adapter.refreshUsage(usageContext(stores, account, google.fetch, () => NOW + 60_000)),
        ).rejects.toThrow("disk full");
        expect(stores.quotas.get(account.id)).toEqual({ ...seeded, error: `${QUOTA_READ_PREFIX}disk full` });
        expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
        expect((await stores.accounts.get(account.id))?.geminiProject).toBe(storedProject);
      },
    );
  });

  it("stores a changed tier on a refresh when the endpoint is unchanged, and leaves the endpoint alone", async () => {
    const stores = await usageStores();
    const account = await storedAccount(stores, "proj-live-agy");
    expect(account.geminiEndpoint).toBe("daily");
    expect(account.subscriptionType).toBe("g1-ultra-lite-tier");
    const google = fakeCodeAssist({
      loads: [{ ...LIVE_AGY_DAILY, paidTier: { id: "g1-ultra-tier" } }],
      quota: ONE_WINDOW,
    });
    const setEndpoint = vi.spyOn(stores.accounts, "setGeminiEndpoint");
    await google.adapter.refreshUsage(
      usageContext(stores, account, google.fetch, () => NOW),
    );
    const stored = await stores.accounts.get(account.id);
    expect(stored?.subscriptionType).toBe("g1-ultra-tier");
    expect(stored?.geminiEndpoint).toBe("daily");
    expect(setEndpoint).not.toHaveBeenCalled();
  });

  type EndpointOutcome = "data" | "empty" | "failed" | "unreadable";
  const ENDPOINT_OUTCOMES: EndpointOutcome[] = ["data", "empty", "failed", "unreadable"];
  const endpointRows = ENDPOINT_OUTCOMES.flatMap((daily) =>
    ENDPOINT_OUTCOMES.map((prod) => [daily, prod] as const),
  );
  const endpointScript = (daily: EndpointOutcome, prod: EndpointOutcome) => {
    const payload = (outcome: EndpointOutcome) =>
      outcome === "data"
        ? {
            buckets: [bucket("gemini-4-neon", 0.3)],
            groups: [
              {
                displayName: "Claude and GPT models",
                buckets: [bucket("3p-5h", 0.9), bucket("3p-weekly", 0.8)],
              },
            ],
          }
        : outcome === "unreadable"
          ? { buckets: "none" }
          : { buckets: [] };
    const quotaByBase: Partial<Record<"daily" | "prod", unknown>> = {};
    const quotaFailureByBase: Partial<Record<"daily" | "prod", number>> = {};
    for (const [base, outcome] of [["daily", daily], ["prod", prod]] as const) {
      if (outcome === "failed") quotaFailureByBase[base] = 503;
      else quotaByBase[base] = payload(outcome);
    }
    return { quotaByBase, quotaFailureByBase };
  };

  it.each(endpointRows)(
    "refreshes with the daily endpoint %s and the prod endpoint %s: an empty answer is real only when no endpoint failed or was unreadable",
    async (daily, prod) => {
      const stores = await usageStores();
      const account = await storedAccount(stores, "proj-live-agy");
      const seed = fakeCodeAssist({ loads: [LIVE_AGY_DAILY], quota: ONE_WINDOW });
      await seed.adapter.refreshUsage(usageContext(stores, account, seed.fetch, () => NOW));
      const seeded = stores.quotas.get(account.id);
      const seededError = "OAuth refresh failed with HTTP 500.";
      stores.quotas.put({ ...seeded, error: seededError });
      const staleDisplay = {
        "Stale 3p": { utilization: 0.77, resetAt: null, status: null, observedAt: NOW, source: "usage" as const },
      };
      stores.quotas.putModelWeekly(account.id, staleDisplay);
      const google = fakeCodeAssist({
        loads: [LIVE_AGY_DAILY],
        ...endpointScript(daily, prod),
      });
      const live = (await stores.accounts.get(account.id)) ?? account;
      const run = google.adapter.refreshUsage(
        usageContext(stores, live, google.fetch, () => NOW + 60_000),
      );
      const outcomes = [daily, prod];
      const hasData = outcomes.includes("data");
      const anyFailed = outcomes.includes("failed") || outcomes.includes("unreadable");
      if (!hasData && anyFailed) {
        await expect(run).rejects.toBeDefined();
        const kept = stores.quotas.get(account.id);
        expect(kept.limitWindows).toEqual(seeded.limitWindows);
        expect(kept.observedAt).toBe(seeded.observedAt);
        expect(kept.error).toMatch(QUOTA_READ_ERROR);
        expect(kept.error).not.toBe(seededError);
        expect(stores.quotas.modelWeekly(account.id)).toEqual(staleDisplay);
        return;
      }
      await run;
      const fresh = stores.quotas.get(account.id);
      expect(fresh.error).toBeNull();
      expect(fresh.observedAt).toBe(NOW + 60_000);
      const display = stores.quotas.modelWeekly(account.id) ?? {};
      expect(Object.keys(display)).not.toContain("Stale 3p");
      if (hasData) {
        expect(fresh.limitWindows).toHaveLength(1);
        expect(fresh.limitWindows[0]?.utilization).toBeCloseTo(0.7);
        expect(Object.keys(display)).toHaveLength(2);
      } else {
        expect(fresh.limitWindows).toEqual([]);
        expect(Object.keys(display)).toHaveLength(0);
      }
    },
  );
});
