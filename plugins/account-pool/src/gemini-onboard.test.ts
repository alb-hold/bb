import { describe, expect, it } from "vitest";
import { createGeminiAdapter, geminiWindowsFromQuota } from "./gemini-adapter.js";

const TOKEN = "access-token-onboard";
const EMAIL = "pro-user@example.com";
const BASES = {
  prod: "https://code-assist.test/prod",
  daily: "https://code-assist.test/daily",
};

interface FakeCall {
  method: string;
  base: string;
  body: Record<string, unknown> | null;
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
    if (rest === "/v1internal:loadCodeAssist") {
      calls.push({ method: "loadCodeAssist", base, body });
      const failure = script.loadFailureByBase?.[base];
      if (failure instanceof Error) throw failure;
      if (failure) return new Response("{}", { status: failure.status });
      const source = script.loadsByBase?.[base]
        ? loadsByBase[base]
        : loads;
      return json(source.length > 1 ? source.shift() : source[0]);
    }
    if (rest === "/v1internal:onboardUser") {
      calls.push({ method: "onboardUser", base, body });
      if (script.onboardFailure !== undefined) {
        if ("error" in script.onboardFailure) throw script.onboardFailure.error;
        return new Response("{}", { status: script.onboardFailure.status });
      }
      return json(script.onboardReplies?.shift() ?? script.onboard);
    }
    if (rest === "/v1internal:retrieveUserQuotaSummary") {
      calls.push({ method: "retrieveUserQuotaSummary", base, body });
      return script.quota === undefined
        ? new Response("{}", { status: 404 })
        : json(script.quota);
    }
    if (rest.startsWith("/v1internal/operations/")) {
      calls.push({ method: "getOperation", base, body });
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
    }),
    onboarding: { pollMs: 5, timeoutMs: 60 },
  });
  return { adapter, calls };
}

const DAILY_NO_PROJECT = { currentTier: { id: "free-tier" } };
const PROD_STANDARD_NO_PROJECT = {
  currentTier: null,
  paidTier: null,
  allowedTiers: [{ id: "standard-tier", isDefault: true }],
};

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
          { bucketId: "gemini-3-pro", remainingFraction: 0.25 },
          { bucketId: "gemini-3-flash", remainingFraction: 0.5 },
        ],
      },
    });
    const probe = await google.adapter.probeImport?.();
    expect(probe).toEqual({
      provider: "gemini",
      endpoints: [
        {
          endpoint: "daily",
          status: "answered",
          currentTier: "standard-tier",
          paidTier: "g1-ultra-tier",
          allowedTiers: [],
          projectPresent: true,
        },
        {
          endpoint: "prod",
          status: "not-loaded",
          currentTier: null,
          paidTier: null,
          allowedTiers: [],
          projectPresent: false,
        },
      ],
      wouldUse: { kind: "project", loadedFrom: "daily", servesOn: "daily" },
      quota: { kind: "answered", windows: 2 },
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "daily"],
      ["retrieveUserQuotaSummary", "daily"],
    ]);
    expect(JSON.stringify(probe)).not.toContain("proj-daily-ultra");
    expect(JSON.stringify(probe)).not.toContain(EMAIL);
    expect(JSON.stringify(probe)).not.toContain(TOKEN);
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
    expect(windows).toMatchObject([
      { slot: "primary", utilization: 0.5, status: "allowed" },
      { slot: "secondary", utilization: 1, status: "rejected" },
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
                  bucketId: "gemini-3-pro",
                  displayName: "Gemini Pro",
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
