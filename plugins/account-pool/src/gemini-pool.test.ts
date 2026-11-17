import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { statusSchema } from "./contracts.js";
import {
  geminiQuotaRejection,
  geminiWindowsFromQuota,
  parseGoogleDuration,
  parseLoadCodeAssist,
} from "./gemini-adapter.js";
import {
  importGeminiCredentials,
  parseGeminiCredentials,
  type ImportedGeminiCredentials,
} from "./gemini-credentials.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import { createAccountPoolPlugin } from "./server.js";
import { createAccountPoolTestHost } from "./test-host.js";

// Every credential below is a fake string. Nothing here reaches Google.

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function fakeJwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

async function writeGeminiHome(args: {
  access: string;
  email?: string;
  idEmail?: string;
}): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "bb-gemini-home-"));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gemini", "oauth_creds.json"),
    JSON.stringify({
      access_token: args.access,
      refresh_token: `refresh-${args.access}`,
      expiry_date: Date.now() + 3_600_000,
      ...(args.idEmail === undefined
        ? {}
        : { id_token: fakeJwt({ email: args.idEmail }) }),
    }),
  );
  if (args.email !== undefined)
    await fs.writeFile(
      path.join(home, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: args.email, old: [] }),
    );
  return home;
}

describe("Gemini credentials from an isolated GEMINI_CLI_HOME", () => {
  it("reads one login per home directory and keeps the homes apart", async () => {
    const homeA = await writeGeminiHome({ access: "tok-a", email: "a@example.com" });
    const homeB = await writeGeminiHome({ access: "tok-b", idEmail: "b@example.com" });
    const a = await importGeminiCredentials(homeA);
    const b = await importGeminiCredentials(homeB);
    expect(a).toMatchObject({ accessToken: "tok-a", email: "a@example.com" });
    expect(b).toMatchObject({ accessToken: "tok-b", email: "b@example.com" });
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });

  it("falls back to GEMINI_CLI_HOME, and says how to sign in when there is no login", async () => {
    const home = await writeGeminiHome({ access: "tok-env", email: "env@example.com" });
    vi.stubEnv("GEMINI_CLI_HOME", home);
    await expect(importGeminiCredentials()).resolves.toMatchObject({
      accessToken: "tok-env",
    });
    const empty = await mkdtemp(path.join(tmpdir(), "bb-gemini-empty-"));
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    await expect(importGeminiCredentials(empty)).rejects.toThrow(
      /GEMINI_CLI_HOME=<dir> gemini/u,
    );
  });

  it("rejects a credentials file without a refresh token", () => {
    expect(() =>
      parseGeminiCredentials(JSON.stringify({ access_token: "x" }), null),
    ).toThrow();
  });
});

describe("Gemini quota parsing", () => {
  it("parses protobuf durations", () => {
    expect(parseGoogleDuration("3600s")).toBe(3_600_000);
    expect(parseGoogleDuration("1h2m3.5s")).toBe(3_723_500);
    expect(parseGoogleDuration("250ms")).toBe(250);
    expect(parseGoogleDuration("soon")).toBeNull();
    expect(parseGoogleDuration(5)).toBeNull();
  });

  it("treats RESOURCE_EXHAUSTED with a quota reason as this account being out", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You have exhausted your capacity on this model.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            metadata: { quotaResetDelay: "90s" },
          },
        ],
      },
    });
    expect(geminiQuotaRejection(body, 1_000)).toEqual({
      reason: "quota_exhausted",
      resetAt: 91_000,
      message: "You have exhausted your capacity on this model.",
    });
  });

  it("does not blame the account for Google-side model capacity", () => {
    const body = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "MODEL_CAPACITY_EXHAUSTED" }],
      },
    });
    expect(geminiQuotaRejection(body, 0)).toBeNull();
    expect(
      geminiQuotaRejection(
        JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Resource exhausted" } }),
        0,
      ),
    ).toBeNull();
    expect(
      geminiQuotaRejection(
        JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ reason: "SOMETHING_NEW" }] } }),
        0,
      ),
    ).toBeNull();
    expect(geminiQuotaRejection('{"error":{"status":"INTERNAL"}}', 0)).toBeNull();
    expect(geminiQuotaRejection("upstream connect error", 0)).toBeNull();
  });

  it("maps retrieveUserQuota buckets to per-account windows", () => {
    const windows = geminiWindowsFromQuota(
      {
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.25,
            resetTime: "2100-01-01T00:00:00Z",
          },
          { modelId: "gemini-2.5-flash", remainingFraction: 1 },
        ],
      },
      5,
    );
    expect(windows).toEqual([
      expect.objectContaining({
        slot: "primary",
        utilization: 0.75,
        status: "allowed",
        resetAt: Date.parse("2100-01-01T00:00:00Z"),
      }),
      expect.objectContaining({ slot: "secondary", utilization: 0 }),
    ]);
    expect(
      geminiWindowsFromQuota(
        { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0 }] },
        5,
      )?.[0],
    ).toMatchObject({ status: "rejected", utilization: 1 });
  });

  it("reads the onboarded project and tier", () => {
    expect(
      parseLoadCodeAssist({
        cloudaicompanionProject: "proj-1",
        currentTier: { name: "Standard" },
        paidTier: { name: "Ultra" },
      }),
    ).toEqual({ project: "proj-1", tier: "Ultra" });
    expect(
      parseLoadCodeAssist({ cloudaicompanionProject: { id: "proj-2" } }),
    ).toEqual({ project: "proj-2", tier: null });
  });
});

interface UpstreamCall {
  method: string;
  bearer: string;
  project: unknown;
  sessionId: unknown;
}

type StreamBehavior = (bearer: string) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

async function startGoogle(args: {
  projects: Record<string, string>;
  quotaFraction: Record<string, number>;
  stream: StreamBehavior;
}): Promise<{ url: string; calls: UpstreamCall[]; close: () => Promise<void> }> {
  const calls: UpstreamCall[] = [];
  const server = http.createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bearer = String(request.headers.authorization ?? "").replace(
          /^Bearer /u,
          "",
        );
        const method = String(request.url).replace(/^\/v1internal:/u, "");
        const raw = Buffer.concat(chunks).toString("utf8");
        const body: Record<string, unknown> =
          raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
        const inner = (body.request ?? {}) as Record<string, unknown>;
        calls.push({
          method,
          bearer,
          project: body.project,
          sessionId: inner.session_id,
        });
        const send = (
          status: number,
          payload: unknown,
          headers: Record<string, string> = {},
        ) => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          for (const [key, value] of Object.entries(headers))
            response.setHeader(key, value);
          response.end(JSON.stringify(payload));
        };
        if (!String(request.url).startsWith("/v1internal:")) {
          send(200, { ok: true });
          return;
        }
        if (method === "loadCodeAssist")
          send(200, {
            cloudaicompanionProject: args.projects[bearer],
            paidTier: { name: "Google AI Ultra" },
          });
        else if (method === "retrieveUserQuota")
          send(200, {
            buckets: [
              {
                modelId: "gemini-2.5-pro",
                remainingFraction: args.quotaFraction[bearer] ?? 1,
                resetTime: "2100-01-01T00:00:00Z",
              },
            ],
          });
        else if (method === "streamGenerateContent") {
          const outcome = args.stream(bearer);
          send(outcome.status, outcome.body, outcome.headers);
        } else send(404, { error: { status: "NOT_FOUND" } });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fake Google did not bind a port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const QUOTA_BODY = {
  error: {
    code: 429,
    message: "Quota exceeded for this account.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "QUOTA_EXHAUSTED",
        metadata: { quotaResetDelay: "3600s" },
      },
    ],
  },
};

const CAPACITY_BODY = {
  error: {
    code: 429,
    message: "No capacity available for this model.",
    status: "RESOURCE_EXHAUSTED",
    details: [{ reason: "MODEL_CAPACITY_EXHAUSTED" }],
  },
};

const OK_BODY = { response: { candidates: [] } };

async function createGeminiFixture(
  google: { url: string },
  homes: Record<string, ImportedGeminiCredentials>,
  withCodex = false,
  withOAuthClient = true,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-gemini-"));
  const requestedHomes: Array<string | undefined> = [];
  const host = createAccountPoolTestHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      threads: {
        events: { list: async () => [] },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId }),
      },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({ plugins: [{ id: "account-pool", enabled: true }] }),
      },
    },
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: google.url,
    codexUpstreamBaseUrl: google.url,
  });
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    codexRefreshUrl: `${google.url}/oauth`,
    codexUsageUrl: `${google.url}/usage`,
    ...(withCodex
      ? {
          importCodexCredentials: async () => ({
            accessToken: "codex-fake-access",
            refreshToken: "codex-fake-refresh",
            idToken: "codex-fake-id",
            accountId: "chatgpt-account-fake",
            planType: null,
            email: "codex@example.com",
            expiresAt: Date.now() + 3_600_000,
          }),
        }
      : {}),
    geminiRefreshUrl: `${google.url}/token`,
    ...(withOAuthClient
      ? {
          geminiOAuthClient: {
            clientId: "test-client",
            clientSecret: "test-secret",
          },
        }
      : {}),
    geminiUpstreamBaseUrl: google.url,
    importGeminiCredentials: async (home?: string) => {
      requestedHomes.push(home);
      const found = home === undefined ? undefined : homes[home];
      if (found === undefined) throw new Error("no fake login for that home");
      return found;
    },
  })(host.bb);
  const service = host.harness.behavior.runService("hub");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await vi.waitFor(async () => {
    expect(
      statusSchema.parse(await host.harness.behavior.callRpc("status.get", null))
        .accepting,
    ).toBe(true);
  });
  return { host, requestedHomes };
}

function creds(access: string, email: string): ImportedGeminiCredentials {
  return {
    accessToken: access,
    refreshToken: `refresh-${access}`,
    idToken: null,
    email,
    expiresAt: Date.now() + 3_600_000,
  };
}

async function geminiEnv(host: Awaited<ReturnType<typeof createGeminiFixture>>["host"]) {
  const entries = await host.harness.behavior.resolveProviderEnv("acp-gemini", {
    threadId: "thread-gemini",
    projectId: "project-one",
    hostId: "host-one",
  });
  const byName = new Map(entries.map((entry) => [entry.name, entry.value]));
  const token = byName.get("GOOGLE_CLOUD_ACCESS_TOKEN");
  const endpoint = byName.get("CODE_ASSIST_ENDPOINT");
  if (typeof token !== "string") throw new Error("Gemini hub token missing.");
  return { token, endpoint, flag: byName.get("GOOGLE_GENAI_USE_GCA") };
}

describe("Gemini account pool", () => {
  async function twoAccounts(stream: StreamBehavior, fractions: Record<string, number> = {}) {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a", "tok-b": "proj-b" },
      quotaFraction: fractions,
      stream,
    });
    cleanups.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/a": creds("tok-a", "a@example.com"),
      "/homes/b": creds("tok-b", "b@example.com"),
    });
    for (const [home, priority] of [
      ["/homes/a", 0],
      ["/homes/b", 100],
    ] as const)
      await fixture.host.harness.behavior.callRpc("account.add", {
        provider: "gemini",
        source: { kind: "import", home },
        label: null,
        priority,
      });
    const env = await geminiEnv(fixture.host);
    const post = (sessionId = "session-1") =>
      fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/gemini/v1internal:streamGenerateContent?alt=sse",
        {
          headers: {
            authorization: `Bearer ${env.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gemini-2.5-pro",
            project: "client-side-project",
            request: { contents: [], session_id: sessionId },
          }),
        },
      );
    return { google, fixture, env, post };
  }

  it("adds accounts from separate homes and records each one's project", async () => {
    const { google, fixture } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    expect(fixture.requestedHomes).toEqual(["/homes/a", "/homes/b"]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    const gemini = status.accounts.filter((account) => account.provider === "gemini");
    expect(gemini.map((account) => account.email).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(google.calls.filter((call) => call.method === "loadCodeAssist").map((call) => call.bearer).sort()).toEqual(["tok-a", "tok-b"]);
    await expect(
      fixture.host.harness.behavior.callRpc("account.add", {
        provider: "gemini",
        source: { kind: "import", home: "/homes/a" },
        label: null,
        priority: 5,
      }),
    ).rejects.toThrow();
  });

  it("names the missing OAuth client when an expired login needs a refresh", async () => {
    vi.stubEnv("BB_GEMINI_OAUTH_CLIENT_ID", "");
    vi.stubEnv("BB_GEMINI_OAUTH_CLIENT_SECRET", "");
    cleanups.push(async () => {
      vi.unstubAllEnvs();
    });
    const google = await startGoogle({
      projects: { "tok-old": "proj-old" },
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    cleanups.push(google.close);
    const fixture = await createGeminiFixture(
      google,
      {
        "/homes/old": { ...creds("tok-old", "old@example.com"), expiresAt: Date.now() - 1_000 },
      },
      false,
      false,
    );
    await expect(
      fixture.host.harness.behavior.callRpc("account.add", {
        provider: "gemini",
        source: { kind: "import", home: "/homes/old" },
        label: null,
        priority: 5,
      }),
    ).rejects.toThrow(/BB_GEMINI_OAUTH_CLIENT_ID/u);
  });

  it("fails over across three accounts and lands on the third one's project", async () => {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a", "tok-b": "proj-b", "tok-c": "proj-c" },
      quotaFraction: {},
      stream: (bearer) =>
        bearer === "tok-c"
          ? { status: 200, body: OK_BODY }
          : { status: 429, body: QUOTA_BODY },
    });
    cleanups.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/a": creds("tok-a", "a@example.com"),
      "/homes/b": creds("tok-b", "b@example.com"),
      "/homes/c": creds("tok-c", "c@example.com"),
    });
    const rpc = fixture.host.harness.behavior;
    for (const [home, priority] of [
      ["/homes/a", 100],
      ["/homes/b", 200],
      ["/homes/c", 300],
    ] as const)
      await rpc.callRpc("account.add", {
        provider: "gemini",
        source: { kind: "import", home },
        label: null,
        priority,
      });
    const env = await geminiEnv(fixture.host);
    const response = await rpc.fetchHttp(
      "POST",
      "/gemini/v1internal:streamGenerateContent?alt=sse",
      {
        headers: {
          authorization: `Bearer ${env.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          project: "client-side-project",
          request: { contents: [], session_id: "s3" },
        }),
      },
    );
    expect(response.status).toBe(200);
    const stream = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(stream.map((call) => call.bearer)).toEqual(["tok-a", "tok-b", "tok-c"]);
    expect(stream.map((call) => call.project)).toEqual(["proj-a", "proj-b", "proj-c"]);
  });

  it("adds an account from the CLI with --home", async () => {
    const google = await startGoogle({
      projects: { "tok-c": "proj-c" },
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    cleanups.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/c": creds("tok-c", "c@example.com"),
    });
    const added = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "gemini",
      "--import",
      "--home",
      "/homes/c",
    ]);
    expect(added.exitCode).toBe(0);
    expect(fixture.requestedHomes).toEqual(["/homes/c"]);
    const listed = await fixture.host.harness.behavior.runCli(["account", "list"]);
    expect(listed.stdout).toContain("gemini");
    const login = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "gemini",
      "--login",
    ]);
    expect(login.exitCode).not.toBe(0);
  });

  it("points gemini-cli at the hub with a thread token and no Google credential", async () => {
    const { env, fixture } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    expect(env.flag).toBe("true");
    expect(env.endpoint).toEqual({
      serverPath: "/api/v1/plugins/account-pool/http/gemini",
    });
    expect(env.token).not.toMatch(/^tok-/u);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("acp-gemini", {
        hostId: "host-one",
      }),
    ).resolves.toMatchObject({ label: "Proxied" });
  });

  it("serves from the first account with that account's project", async () => {
    const { google, post } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    const response = await post();
    expect(response.status).toBe(200);
    const stream = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(stream).toEqual([
      expect.objectContaining({ bearer: "tok-a", project: "proj-a" }),
    ]);
  });

  it("fails over on RESOURCE_EXHAUSTED and rewrites the project to the next account", async () => {
    const { google, post } = await twoAccounts((bearer) =>
      bearer === "tok-a"
        ? { status: 429, body: QUOTA_BODY }
        : { status: 200, body: OK_BODY },
    );
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_BODY);
    const stream = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(stream.map((call) => [call.bearer, call.project])).toEqual([
      ["tok-a", "proj-a"],
      ["tok-b", "proj-b"],
    ]);
    // Account A is now out for the reset window: the next conversation skips it.
    await (await post("session-2")).text();
    const after = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(after.slice(2).map((call) => call.bearer)).toEqual(["tok-b"]);
  });

  it("does not mark an account out of quota for Google-side model capacity", async () => {
    const { google, post, fixture } = await twoAccounts((bearer) =>
      bearer === "tok-a"
        ? { status: 429, body: CAPACITY_BODY }
        : { status: 200, body: OK_BODY },
    );
    expect((await post()).status).toBe(200);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    const a = status.accounts.find((account) => account.email === "a@example.com");
    expect(a?.usageRestriction ?? null).toBeNull();
    expect(
      google.calls.filter((call) => call.method === "streamGenerateContent")[0]?.bearer,
    ).toBe("tok-a");
  });

  it("does not hold any account after a reasonless or capacity 429, even with Retry-After", async () => {
    let degraded = true;
    const { post } = await twoAccounts(() =>
      degraded
        ? {
            status: 429,
            body: CAPACITY_BODY,
            headers: { "retry-after": "3600" },
          }
        : { status: 200, body: OK_BODY },
    );
    expect((await post("s-capacity-1")).status).toBe(429);
    degraded = false;
    // Held accounts would still be skipped here; none may be.
    expect((await post("s-capacity-2")).status).toBe(200);
  });

  it("returns the last Google error when every account is out", async () => {
    const { post } = await twoAccounts(() => ({ status: 429, body: QUOTA_BODY }));
    const response = await post();
    expect(response.status).toBe(429);
    expect(JSON.stringify(await response.json())).toContain("RESOURCE_EXHAUSTED");
  });

  it("reads usage per account from retrieveUserQuota", async () => {
    const { fixture, google } = await twoAccounts(
      () => ({ status: 200, body: OK_BODY }),
      { "tok-a": 0.25, "tok-b": 0.9 },
    );
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    for (const account of status.accounts)
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: account.id,
      });
    const refreshed = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    const used = (email: string) =>
      refreshed.accounts.find((account) => account.email === email)
        ?.limitWindows[0]?.utilization;
    expect(used("a@example.com")).toBeCloseTo(0.75);
    expect(used("b@example.com")).toBeCloseTo(0.1);
    expect(
      google.calls.filter((call) => call.method === "retrieveUserQuota").map((call) => call.project).sort(),
    ).toEqual(expect.arrayContaining(["proj-a", "proj-b"]));
  });
});

// Frozen copies of the schemas an older build (origin/ours 198f84bf) applies
// to stored rows. They are deliberately NOT imported from contracts.ts: the
// point is what a build that only knows claude|codex does with this store.
const OLD_PROVIDERS = z.enum(["claude", "codex"]);
const oldAccountSchema = z
  .object({
    id: z.string().uuid(),
    provider: OLD_PROVIDERS,
    kind: z.enum(["oauth", "api-key"]),
    label: z.string().min(1),
    email: z.string().email().nullable(),
    accountUuid: z.string().uuid().nullable().default(null),
    codexAccountId: z.string().min(1).optional(),
    subscriptionType: z.string().nullable(),
    rateLimitTier: z.string().nullable(),
    enabled: z.boolean(),
    priority: z.number().int(),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable().default(null),
    lastUsedHostId: z.string().min(1).nullable().default(null),
  })
  .strict();
const oldAccountsSchema = z.array(oldAccountSchema);
const oldActiveAccountRowSchema = z.object({
  provider: OLD_PROVIDERS,
  account_id: z.string().uuid(),
});

describe("Gemini rows and an older build", () => {
  async function storeWithGeminiAndClaude() {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a", "tok-b": "proj-b" },
      quotaFraction: {},
      stream: (bearer) =>
        bearer === "tok-a"
          ? { status: 429, body: QUOTA_BODY }
          : { status: 200, body: OK_BODY },
    });
    cleanups.push(google.close);
    const fixture = await createGeminiFixture(
      google,
      {
        "/homes/a": creds("tok-a", "a@example.com"),
        "/homes/b": creds("tok-b", "b@example.com"),
      },
      true,
    );
    const rpc = fixture.host.harness.behavior;
    const claude = (await rpc.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-fake-claude" },
      label: "Claude fake",
      priority: 50,
    })) as { id: string };
    const codex = (await rpc.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 60,
    })) as { id: string };
    for (const [home, priority] of [
      ["/homes/a", 100],
      ["/homes/b", 200],
    ] as const)
      await rpc.callRpc("account.add", {
        provider: "gemini",
        source: { kind: "import", home },
        label: null,
        priority,
      });
    const env = await geminiEnv(fixture.host);
    // Real Gemini traffic with a forced failover, so the active account moves.
    const response = await rpc.fetchHttp(
      "POST",
      "/gemini/v1internal:streamGenerateContent?alt=sse",
      {
        headers: {
          authorization: `Bearer ${env.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          project: "x",
          request: { contents: [], session_id: "s1" },
        }),
      },
    );
    expect(response.status).toBe(200);
    return { fixture, claude, codex, google };
  }

  it("leaves the claude/codex account list parseable by the old schema", async () => {
    const { fixture, claude, codex } = await storeWithGeminiAndClaude();
    const kv = fixture.host.bb.storage.kv;
    const stored = await kv.get("accounts:v1");
    const oldView = oldAccountsSchema.parse(stored);
    expect(oldView.map((account) => account.id).sort()).toEqual(
      [claude.id, codex.id].sort(),
    );
    // The Gemini row exists, just not where an older build looks.
    const geminiRows = (await kv.get("accounts:gemini:v1")) as Array<{
      provider: string;
    }>;
    expect(geminiRows.map((row) => row.provider)).toEqual(["gemini"]);
    expect(() => oldAccountsSchema.parse(geminiRows)).toThrow();
  });

  it("writes no active-account row the old parser would choke on", async () => {
    const { fixture } = await storeWithGeminiAndClaude();
    const db = fixture.host.bb.storage.database();
    const rows = db.prepare("SELECT * FROM pool_active_account").all();
    expect(() => z.array(oldActiveAccountRowSchema).parse(rows)).not.toThrow();
    expect(rows.some((row) => (row as { provider: string }).provider === "gemini")).toBe(false);
    const choices = db.prepare("SELECT * FROM pool_automatic_choice").all();
    expect(
      choices.some((row) => (row as { provider: string }).provider === "gemini"),
    ).toBe(false);
  });

  it("keeps serving Claude and Codex requests after Gemini rows exist", async () => {
    const { fixture, google } = await storeWithGeminiAndClaude();
    const rpc = fixture.host.harness.behavior;
    const claudeEntries = await rpc.resolveProviderEnv("claude-code", {
      threadId: "thread-claude",
      projectId: "project-one",
      hostId: "host-one",
    });
    const claudeToken = claudeEntries.find(
      (entry) =>
        entry.name === "ANTHROPIC_AUTH_TOKEN" ||
        entry.name === "CLAUDE_CODE_OAUTH_TOKEN",
    )?.value;
    if (typeof claudeToken !== "string") throw new Error("no claude token");
    const claudeResponse = await rpc.fetchHttp("POST", "/v1/messages", {
      headers: {
        authorization: `Bearer ${claudeToken}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-opus-4-1", messages: [], max_tokens: 1 }),
    });
    expect(claudeResponse.status).toBe(200);
    const codexEntries = await rpc.resolveProviderEnv("codex", {
      threadId: "thread-codex",
      projectId: "project-one",
      hostId: "host-one",
    });
    const codexToken = codexEntries.find(
      (entry) => entry.name === "CODEX_POOL_AUTH_TOKEN",
    )?.value;
    if (typeof codexToken !== "string") throw new Error("no codex token");
    const codexResponse = await rpc.fetchHttp("POST", "/v1/responses", {
      headers: {
        authorization: "Bearer local-codex-token",
        "x-bb-account-pool-token": codexToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5", input: [] }),
    });
    expect(codexResponse.status).toBe(200);
    const seen = google.calls.map((call) => call.method);
    expect(seen.some((url) => url.includes("messages"))).toBe(true);
    expect(seen.some((url) => url.includes("responses"))).toBe(true);
    const status = statusSchema.parse(await rpc.callRpc("status.get", null));
    expect(status.accounts.map((account) => account.provider).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
      "gemini",
    ]);
  });
});
