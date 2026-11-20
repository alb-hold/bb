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
  onboard?: unknown;
  operations?: unknown[];
}) {
  const calls: FakeCall[] = [];
  const loads = [...script.loads];
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
      return json(loads.length > 1 ? loads.shift() : loads[0]);
    }
    if (rest === "/v1internal:onboardUser") {
      calls.push({ method: "onboardUser", base, body });
      return json(script.onboard);
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

  it("onboards an account with no project yet, waits for the operation, then adds it", async () => {
    const google = fakeCodeAssist({
      loads: [
        {
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
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(EMAIL);
    expect(
      google.calls.filter((call) => call.method === "getOperation").length,
    ).toBeGreaterThan(1);
    expect(google.calls.filter((call) => call.method === "loadCodeAssist")).toHaveLength(1);
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
