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
  onboard?: unknown;
  onboardReplies?: unknown[];
  operations?: unknown[];
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
      const source = script.loadsByBase?.[base]
        ? loadsByBase[base]
        : loads;
      return json(source.length > 1 ? source.shift() : source[0]);
    }
    if (rest === "/v1internal:onboardUser") {
      calls.push({ method: "onboardUser", base, body });
      return json(script.onboardReplies?.shift() ?? script.onboard);
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
      loads: [
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
    expect(google.calls.map((call) => call.method)).toEqual([
      "loadCodeAssist",
      "onboardUser",
      "getOperation",
      "loadCodeAssist",
    ]);
    expect(google.calls[1]?.body).toMatchObject({ tierId: "g1-pro-tier" });
  });

  it("onboards to the paid tier, not the free current tier, when Google marks no default", async () => {
    const google = fakeCodeAssist({
      loads: [
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
    expect(google.calls[1]).toMatchObject({
      method: "onboardUser",
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
        "loadCodeAssist", "onboardUser", "onboardUser", "getOperation", "getOperation", "loadCodeAssist",
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
      "tier ids: current=none, paid=none, allowed=g1-pro-tier(default))",
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(EMAIL);
    expect(
      google.calls.filter((call) => call.method === "getOperation").length,
    ).toBeGreaterThan(1);
    expect(google.calls.filter((call) => call.method === "loadCodeAssist")).toHaveLength(1);
  });

  it("does not guess a tier when Google marks none as the default", async () => {
    const google = fakeCodeAssist({
      loads: [{ allowedTiers: [{ id: "free-tier" }, { id: "g1-pro-tier" }] }],
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /no project and tier.*stage: loadCodeAssist; tier ids: current=none, paid=none, allowed=free-tier,g1-pro-tier/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
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
      /no project for this account and offered no tier.*stage: loadCodeAssist; tier ids: current=none, paid=g1-pro-tier, allowed=free-tier/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
  });

  it("does not onboard when Google sends an empty list of allowed tiers", async () => {
    const google = fakeCodeAssist({
      loads: [{ paidTier: { id: "g1-pro-tier" }, allowedTiers: [] }],
    });
    await expect(google.adapter.importAccount()).rejects.toThrow(
      /no project for this account and offered no tier.*stage: loadCodeAssist; tier ids: current=none, paid=g1-pro-tier, allowed=none/u,
    );
    expect(google.calls.map((call) => call.method)).toEqual(["loadCodeAssist"]);
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

  it("loads an Ultra account from daily when prod has no managed project", async () => {
    const google = fakeCodeAssist({
      loads: [],
      loadsByBase: {
        prod: [
          {
            currentTier: { id: "standard-tier" },
            paidTier: { id: "google-ai-ultra-tier", usesGcpTos: false },
            allowedTiers: [
              { id: "standard-tier", isDefault: true },
              { id: "google-ai-ultra-tier" },
            ],
          },
        ],
        daily: [
          {
            cloudaicompanionProject: { id: "proj-ultra-managed" },
            currentTier: { id: "standard-tier" },
            paidTier: {
              id: "google-ai-ultra-tier",
              name: "Google AI Ultra",
              usesGcpTos: false,
            },
          },
        ],
      },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-ultra-managed",
      subscriptionType: "Google AI Ultra",
      geminiEndpoint: "daily",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "prod"],
      ["loadCodeAssist", "daily"],
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

  it("continues Pro onboarding without loading the daily endpoint", async () => {
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
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("keeps the existing Pro no-project error without loading daily", async () => {
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
      },
      onboard: { done: true, response: {} },
    });
    const error = await google.adapter.importAccount().catch((reason: Error) => reason.message);
    expect(error).toContain("GOOGLE_CLOUD_PROJECT");
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
  });

  it("keeps a Pro account on prod even when daily has a project", async () => {
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
          {
            cloudaicompanionProject: "proj-pro-prod",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro", usesGcpTos: false },
          },
        ],
        daily: [
          {
            cloudaicompanionProject: "proj-pro-daily",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro", usesGcpTos: false },
          },
        ],
      },
      onboard: {
        done: true,
        response: { cloudaicompanionProject: "proj-pro-prod" },
      },
    });
    const account = await google.adapter.importAccount();
    expect(account).toMatchObject({
      geminiProject: "proj-pro-prod",
      subscriptionType: "Google AI Pro",
    });
    expect(google.calls.map(({ method, base }) => [method, base])).toEqual([
      ["loadCodeAssist", "prod"],
      ["onboardUser", "prod"],
      ["loadCodeAssist", "prod"],
    ]);
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
});
