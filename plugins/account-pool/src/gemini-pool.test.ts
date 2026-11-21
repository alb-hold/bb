import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { statusSchema } from "./contracts.js";
import { createGeminiAdapter, geminiQuotaRejection, geminiWindowsFromQuota, parseGoogleDuration, parseLoadCodeAssist } from "./gemini-adapter.js";
import {
  importGeminiCredentials,
  keychainReadOutcome,
  readAntigravityInstalledAppClient,
  parseGeminiCredentials,
  type ImportedGeminiCredentials,
} from "./gemini-credentials.js";
import {
  codeAssistModel,
  codeAssistModels,
  geminiRuntimeRefusal,
  geminiUpstreamUserAgent,
  unwrapSse,
} from "./gemini-gateway.js";
import { isSignInRejection } from "./provider-adapter.js";
import { pruneGeminiHomes, writeGeminiHome } from "./gemini-home.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import { createAccountPoolPlugin } from "./server.js";
import { createAccountPoolTestHost } from "./test-host.js";


const GEMINI_PROVIDER_ID = "acp-antigravity-acp";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_RUNTIME = path.join(FIXTURES, "fake-antigravity-acp.mjs");
const FAKE_CHROME = path.join(FIXTURES, "fake-chrome.mjs");

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${file} never appeared`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function accountSecretFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((entry) => /(^|\/)account-[^/]*\.json$/u.test(entry));
}
const THREAD = "thr_gemini2345";
const CLIENT = { clientId: "agy-client", clientSecret: "agy-secret" };

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});

const upstreams: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (upstreams.length > 0) await upstreams.pop()?.();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSignIn(args: {
  refresh: string;
  projectId?: string;
}): Promise<string> {
  const home = await tempDir("bb-agy-home-");
  await fs.mkdir(path.join(home, "antigravity-acp"), { recursive: true });
  await fs.writeFile(
    path.join(home, "antigravity-acp", "acp_token.json"),
    JSON.stringify({
      type: "authorized_user",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      refresh_token: args.refresh,
      ...(args.projectId === undefined ? {} : { project_id: args.projectId }),
    }),
  );
  return home;
}

describe("Gemini credentials from an antigravity-acp GEMINI_HOME", () => {
  it("reads one sign-in per home, with the client its token belongs to", async () => {
    const homeA = await writeSignIn({ refresh: "refresh-a", projectId: "proj-a" });
    const homeB = await writeSignIn({ refresh: "refresh-b" });
    await expect(importGeminiCredentials(homeA)).resolves.toEqual({
      refreshToken: "refresh-a",
      client: CLIENT,
      projectId: "proj-a",
    });
    await expect(importGeminiCredentials(homeB)).resolves.toEqual({
      refreshToken: "refresh-b",
      client: CLIENT,
      projectId: null,
    });
  });

  it("falls back to GEMINI_HOME, and says how to sign in when there is none", async () => {
    const home = await writeSignIn({ refresh: "refresh-env" });
    vi.stubEnv("GEMINI_HOME", home);
    await expect(importGeminiCredentials()).resolves.toMatchObject({
      refreshToken: "refresh-env",
    });
    const empty = await tempDir("bb-agy-empty-");
    await expect(importGeminiCredentials(empty)).rejects.toThrow(
      /GEMINI_HOME=<dir> and AGY_ACP_FORCE_FILE_STORAGE=1/u,
    );
  });

  it("requires a refresh token and identifies a client-less file as consumer", () => {
    expect(() =>
      parseGeminiCredentials(
        JSON.stringify({ client_id: "c", client_secret: "s" }),
      ),
    ).toThrow();
    expect(parseGeminiCredentials(JSON.stringify({ refresh_token: "fake-refresh" }))).toEqual({
      refreshToken: "fake-refresh", client: null, installedAppClient: "consumer", projectId: null,
    });
  });
});

describe("Gemini credentials from the macOS keychain", () => {
  const secret = JSON.stringify({
    type: "authorized_user",
    client_id: CLIENT.clientId,
    client_secret: "fake-secret-kc",
    refresh_token: "fake-refresh-kc",
    project_id: "proj-kc",
  });
  const expected = {
    refreshToken: "fake-refresh-kc",
    client: { clientId: CLIENT.clientId, clientSecret: "fake-secret-kc" },
    projectId: "proj-kc",
  };

  it("imports credentials from the antigravity-acp keychain account", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const readKeychain = vi.fn(async () => ({ kind: "found" as const, secret }));
    const readInstalledAppClient = vi.fn();
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain, readInstalledAppClient })).resolves.toEqual(expected);
    expect(readInstalledAppClient).not.toHaveBeenCalled();
    expect(readKeychain).toHaveBeenCalledWith("gemini", "antigravity-acp");
  });

  const goToken = { refresh_token: "fake-refresh-kc", access_token: "fake-access", token_type: "Bearer", expiry: "2030-01-01T00:00:00Z" };

  it.each([
    ["plain", JSON.stringify(goToken)],
    ["go-keyring", `go-keyring-base64:${Buffer.from(JSON.stringify(goToken)).toString("base64")}`],
    ["nested", JSON.stringify({ token: goToken })],
    ["camelCase", JSON.stringify({ refreshToken: goToken.refresh_token })],
    ["business", JSON.stringify(goToken)],
  ])("resolves the installed client for a %s item", async (variant, item) => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const business = variant === "business";
    const target = business ? "antigravity-acp-business" : "antigravity";
    const readKeychain = vi.fn(async (_service: string, account: string) => account === target
      ? { kind: "found" as const, secret: item }
      : { kind: "missing" as const });
    const readInstalledAppClient = vi.fn(async () => CLIENT);
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain, readInstalledAppClient })).resolves.toEqual({
      refreshToken: goToken.refresh_token, client: CLIENT, projectId: null, clientSource: "antigravity-installed-app",
    });
    expect(readInstalledAppClient).toHaveBeenCalledWith(business ? "business" : "consumer");
    expect(readKeychain.mock.calls.map(([, account]) => account)).toEqual(
      business ? ["antigravity-acp", "antigravity", target] : ["antigravity-acp", target],
    );
  });

  it("propagates a client reader failure", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const failure = new Error("synthetic reader failure");
    await expect(importGeminiCredentials(undefined, {
      platform: "darwin",
      readKeychain: async () => ({ kind: "found", secret: JSON.stringify(goToken) }),
      readInstalledAppClient: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it("reports only usable field names for each account", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const items: Record<string, string> = {
      "antigravity-acp": JSON.stringify({ access_token: "fake-access", expiry: 0 }),
      antigravity: JSON.stringify({ token: { refresh_token: 42 } }),
      "antigravity-acp-business": "fake-invalid-json",
    };
    const result = importGeminiCredentials(undefined, {
      platform: "darwin", readInstalledAppClient: vi.fn(),
      readKeychain: async (_service, account) => ({ kind: "found", secret: items[account]! }),
    });
    await expect(result).rejects.toThrow('"antigravity-acp": present: access_token, expiry; missing: refresh_token, client_id, client_secret, token_uri');
    await expect(result).rejects.toThrow('"antigravity": present: none; missing: refresh_token, access_token, expiry, client_id, client_secret, token_uri');
    await expect(result).rejects.toThrow('"antigravity-acp-business": not readable as JSON');
    await expect(result).rejects.not.toThrow(/fake-access|fake-invalid-json/u);
  });

  it("tries the antigravity account and decodes go-keyring credentials", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const readKeychain = vi.fn(async (_service: string, account: string) => account === "antigravity-acp"
      ? { kind: "missing" as const }
      : { kind: "found" as const, secret: `go-keyring-base64:${Buffer.from(secret).toString("base64")}` });
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain })).resolves.toEqual(expected);
    expect(readKeychain.mock.calls.map(([service, account]) => [service, account])).toEqual([
      ["gemini", "antigravity-acp"],
      ["gemini", "antigravity"],
    ]);
  });

  it("reports when neither keychain account has a sign-in", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const readKeychain = vi.fn(async () => ({ kind: "missing" as const }));
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain })).rejects.toThrow(/not found or usable.*without --home/u);
  });

  it("rejects unusable keychain values without exposing secret contents", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    for (const value of ["fake-secret-kc", JSON.stringify({ client_secret: "fake-secret-kc", refresh_token: 42 })]) {
      const readKeychain = vi.fn(async () => ({ kind: "found" as const, secret: value }));
      let message = "";
      try {
        await importGeminiCredentials(undefined, { platform: "darwin", readKeychain });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/has no refresh token that bb can read/u);
      expect(message).not.toContain("fake-secret-kc");
    }
  });

  it("explains keychain access outcomes", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    for (const kind of ["needs-allow", "denied", "timeout"] as const) {
      const readKeychain = vi.fn(async () => ({ kind }));
      await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain })).rejects.toThrow(/Click Allow/u);
      await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain })).rejects.not.toThrow(/password/u);
    }
    const failed = vi.fn(async () => ({ kind: "failed" as const }));
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain: failed })).rejects.toThrow(/Unlock the login keychain/u);
  });

  it("does not read the keychain when an explicit home is supplied", async () => {
    const home = await tempDir("bb-agy-empty-kc-");
    const readKeychain = vi.fn(async () => ({ kind: "found" as const, secret }));
    await expect(importGeminiCredentials(home, { platform: "darwin", readKeychain })).rejects.toThrow(/omit --home/u);
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("prefers a token file in GEMINI_HOME", async () => {
    const home = await writeSignIn({ refresh: "file-refresh-kc" });
    vi.stubEnv("GEMINI_HOME", home);
    const readKeychain = vi.fn(async () => ({ kind: "found" as const, secret }));
    await expect(importGeminiCredentials(undefined, { platform: "darwin", readKeychain })).resolves.toMatchObject({ refreshToken: "file-refresh-kc" });
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("does not read the keychain on Linux", async () => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-kc-"));
    const readKeychain = vi.fn(async () => ({ kind: "found" as const, secret }));
    await expect(importGeminiCredentials(undefined, { platform: "linux", readKeychain })).rejects.toThrow(/not found or usable/u);
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("maps macOS security command outcomes", () => {
    expect(keychainReadOutcome(null, "secret-out", "")).toEqual({ kind: "found", secret: "secret-out" });
    expect(keychainReadOutcome({ killed: true }, "", "")).toEqual({ kind: "timeout" });
    expect(keychainReadOutcome({ code: 44 }, "", "")).toEqual({ kind: "missing" });
    expect(keychainReadOutcome({ code: 36 }, "", "")).toEqual({ kind: "needs-allow" });
    expect(keychainReadOutcome({ code: 128 }, "", "")).toEqual({ kind: "denied" });
    expect(keychainReadOutcome({ code: 51 }, "", "")).toEqual({ kind: "denied" });
    expect(keychainReadOutcome({ code: 2 }, "", "User canceled the operation.")).toEqual({ kind: "denied" });
    expect(keychainReadOutcome({ code: 1 }, "", "Other error")).toEqual({ kind: "failed" });
  });
});

describe("Antigravity runtime client reader", () => {
  const id = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
  const consumer = { clientId: id, clientSecret: "fake-installed-secret-consumer" };
  const business = { clientId: id.replace("123456", "654321"), clientSecret: "fake-installed-secret-business" };
  const markers = `_DEFAULT_CLIENT_ID = (\n "${consumer.clientId}"\n)\n_DEFAULT_CLIENT_SECRET = "${consumer.clientSecret}"\n_BUSINESS_CLIENT_ID = "${business.clientId}"\n_BUSINESS_CLIENT_SECRET = "${business.clientSecret}"`;

  async function runtime(root: string, version: string, contents: string) {
    const directory = path.join(root, version);
    await fs.mkdir(directory);
    const file = path.join(directory, "agy_acp_server.par");
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0, 0x81]), Buffer.from(contents)]));
    return file;
  }

  it("reads both clients from the newest version containing a runtime", async () => {
    const runtimeRoot = await tempDir("bb-agy-runtime-");
    await runtime(runtimeRoot, "1.4.0", "");
    await runtime(runtimeRoot, "1.10.0", markers);
    await fs.mkdir(path.join(runtimeRoot, "2.0.0"));
    await expect(readAntigravityInstalledAppClient("consumer", { runtimeRoot })).resolves.toEqual(consumer);
    await expect(readAntigravityInstalledAppClient("business", { runtimeRoot })).resolves.toEqual(business);
  });

  it("names the missing runtime root", async () => {
    const runtimeRoot = path.join(await tempDir("bb-agy-runtime-"), "missing");
    const result = readAntigravityInstalledAppClient("consumer", { runtimeRoot });
    await expect(result).rejects.toThrow("no Antigravity runtime");
    await expect(result).rejects.toThrow(runtimeRoot);
  });

  it.each([
    ["absent", consumer.clientSecret],
    ["ambiguous", `${markers}\n_DEFAULT_CLIENT_SECRET = "fake-installed-secret-other"`],
  ])("redacts %s runtime markers", async (_variant, contents) => {
    const runtimeRoot = await tempDir("bb-agy-runtime-");
    const file = await runtime(runtimeRoot, "1.10.0", contents);
    const result = readAntigravityInstalledAppClient("consumer", { runtimeRoot });
    await expect(result).rejects.toThrow(`consumer installed-app client was not found in ${file} (version 1.10.0)`);
    await expect(result).rejects.not.toThrow(/fake-installed-secret/u);
  });
});

describe("Gemini import refresh errors", () => {
  it.each(["invalid_grant", "invalid_client"])("reports %s from the configured refresh endpoint", async (code) => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-refresh-"));
    const refreshUrl = "https://example.invalid/token";
    const installed = code === "invalid_grant";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: code }, { status: 400 }));
    const adapter = createGeminiAdapter({
      refreshUrl, fetch, upstreamBaseUrls: { prod: "https://example.invalid", daily: "https://example.invalid" },
      importCredentials: async () => ({
        refreshToken: "fake-refresh-kc", client: CLIENT, projectId: null,
        ...(installed && { clientSource: "antigravity-installed-app" as const }),
      }),
    });
    const result = adapter.importAccount();
    await expect(result).rejects.toThrow(installed ? /installed-app client.*invalid_grant/u : /HTTP 400\. invalid_client\.$/u);
    await expect(result).rejects.not.toThrow("fake-refresh-kc");
    if (!installed) {
      const message = await result.then(() => "", (error: Error) => error.message);
      expect(isSignInRejection(message)).toBe(true);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(refreshUrl);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe(CLIENT.clientId);
    expect(form.get("client_secret")).toBe(CLIENT.clientSecret);
  });
});

describe("Gemini import refresh with a stalled error body", () => {
  it.each([400, 401])("rejects an import whose HTTP %s error body never arrives", async (status) => {
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-stall-"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start() {} }), {
      status, headers: { "content-type": "application/json" },
    }));
    const adapter = createGeminiAdapter({
      refreshUrl: "https://example.invalid/token", fetch,
      upstreamBaseUrls: { prod: "https://example.invalid", daily: "https://example.invalid" },
      importCredentials: async () => ({
        refreshToken: "fake-refresh-stall", client: CLIENT, projectId: null, clientSource: "antigravity-installed-app" as const,
      }),
    });
    const started = Date.now();
    const result = adapter.importAccount();
    await expect(result).rejects.toThrow(`OAuth refresh failed with HTTP ${status}.`);
    await expect(result).rejects.not.toThrow("fake-refresh-stall");
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 5_000);
});

describe("Gemini adapter local login", () => {
  it("returns null when the empty GEMINI_HOME has no local sign-in", async () => {
    const home = await tempDir("bb-agy-empty-local-login-");
    vi.stubEnv("GEMINI_HOME", home);
    const adapter = createGeminiAdapter({
      refreshUrl: "https://example.invalid/token",
      upstreamBaseUrls: { prod: "https://example.invalid", daily: "https://example.invalid" },
    });
    await expect(adapter.localLogin()).resolves.toBeNull();
  });

  it("reads only the token file and never the import override", async () => {
    const importCredentials = vi.fn(async () => {
      throw new Error("keychain-capable import must not run during listing");
    });
    const adapter = createGeminiAdapter({
      refreshUrl: "https://example.invalid/token",
      upstreamBaseUrls: { prod: "https://example.invalid", daily: "https://example.invalid" },
      importCredentials,
    });
    vi.stubEnv("GEMINI_HOME", await tempDir("bb-agy-empty-override-"));
    await expect(adapter.localLogin()).resolves.toBeNull();
    vi.stubEnv("GEMINI_HOME", await writeSignIn({ refresh: "fake-refresh-local" }));
    await expect(adapter.localLogin()).resolves.toEqual({ email: null, planLabel: null });
    expect(importCredentials).not.toHaveBeenCalled();
  });
});

describe("Gemini homes the host worker writes", () => {
  it("holds only settings that select the gateway sign-in, privately, and no token", async () => {
    const dataDir = await tempDir("bb-host-data-");
    const runtimeDir = path.join(dataDir, "gemini-homes", THREAD, "antigravity-acp");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "acp_token.json"), '{"refresh_token":"old"}');
    await fs.writeFile(
      path.join(runtimeDir, "settings.json"),
      '{"auth":{"type":"oauth-personal","extra":true},"x":1}',
    );
    const home = await writeGeminiHome({ dataDir, key: THREAD });
    expect(home).toBe(path.join(dataDir, "gemini-homes", THREAD));
    expect(await fs.readdir(runtimeDir)).toEqual(["settings.json"]);
    const settings = path.join(runtimeDir, "settings.json");
    expect(JSON.parse(await fs.readFile(settings, "utf8"))).toEqual({
      auth: { type: "gateway", extra: true },
      x: 1,
    });
    expect((await fs.stat(settings)).mode & 0o777).toBe(0o600);
    for (const dir of [path.join(dataDir, "gemini-homes"), home, runtimeDir])
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const fresh = await writeGeminiHome({ dataDir, key: "catalog" });
    expect(
      JSON.parse(
        await fs.readFile(path.join(fresh, "antigravity-acp", "settings.json"), "utf8"),
      ),
    ).toEqual({ auth: { type: "gateway" } });
  });

  it("refuses a key that is not a thread id, and a home that is a symlink", async () => {
    const dataDir = await tempDir("bb-host-data-");
    for (const key of ["../escape", "thr_short", "thr_gemini2345/x", ""])
      await expect(
        writeGeminiHome({ dataDir, key }),
      ).rejects.toThrow(/invalid thread id/u);
    const elsewhere = await tempDir("bb-elsewhere-");
    await fs.mkdir(path.join(dataDir, "gemini-homes"), { recursive: true });
    await fs.symlink(elsewhere, path.join(dataDir, "gemini-homes", THREAD));
    await expect(
      writeGeminiHome({ dataDir, key: THREAD }),
    ).rejects.toThrow(/not a directory/u);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("prunes homes of threads that lost their route, never the catalog's", async () => {
    const dataDir = await tempDir("bb-host-data-");
    for (const key of [THREAD, "thr_revkd23456", "catalog"])
      await writeGeminiHome({ dataDir, key });
    await expect(pruneGeminiHomes({ dataDir, keep: [THREAD] })).resolves.toBe(1);
    expect((await fs.readdir(path.join(dataDir, "gemini-homes"))).sort()).toEqual([
      "catalog",
      THREAD,
    ]);
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
      message: body,
    });
  });

  it("does not blame the account for a third-party model's quota", () => {
    const body = JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            reason: "QUOTA_EXHAUSTED",
            metadata: { quotaResetDelay: "90s", model: "claude-sonnet-4-5" },
          },
        ],
      },
    });
    expect(geminiQuotaRejection(body, 0)).toBeNull();
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

  it("maps retrieveUserQuotaSummary buckets to per-account windows", () => {
    const windows = geminiWindowsFromQuota(
      {
        buckets: [
          {
            bucketId: "gemini-3-pro",
            remainingFraction: 0.25,
            resetTime: "2100-01-01T00:00:00Z",
          },
          { bucketId: "gemini-3-flash", remainingFraction: 1 },
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
        { buckets: [{ bucketId: "gemini-3-pro", remainingFraction: 0 }] },
        5,
      )?.[0],
    ).toMatchObject({ status: "rejected", utilization: 1 });
  });

  it("reads grouped buckets, and skips disabled and third-party ones", () => {
    const windows = geminiWindowsFromQuota(
      {
        buckets: [
          { bucketId: "claude-opus", remainingFraction: 0 },
          { displayName: "GPT-OSS 120B", remainingFraction: 0 },
          { bucketId: "gemini-image", remainingFraction: 0 },
        ],
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "carbon", remainingFraction: 0.6 },
              { bucketId: "argon", remainingFraction: 0, disabled: true },
              { bucketId: "gemini-3-flash", remainingFraction: 0.5 },
            ],
          },
        ],
      },
      5,
    );
    expect(windows).toEqual([
      expect.objectContaining({ slot: "primary", utilization: 0.4, status: "allowed" }),
      expect.objectContaining({ slot: "secondary", utilization: 0.5, status: "allowed" }),
    ]);
    expect(
      geminiWindowsFromQuota(
        { buckets: [{ bucketId: "claude-sonnet", remainingFraction: 0 }] },
        5,
      ),
    ).toEqual([]);
  });

  it("reads the onboarded project and tier", () => {
    expect(
      parseLoadCodeAssist({
        cloudaicompanionProject: "proj-1",
        currentTier: { name: "Standard" },
        paidTier: { name: "Ultra" },
      }),
    ).toEqual({ project: "proj-1", tier: "Ultra", endpoint: "daily" });
    expect(
      parseLoadCodeAssist({ cloudaicompanionProject: { id: "proj-2" } }),
    ).toEqual({ project: "proj-2", tier: null, endpoint: "daily" });
    expect(
      parseLoadCodeAssist({
        cloudaicompanionProject: "proj-3",
        paidTier: { name: "Enterprise", usesGcpTos: true },
      }),
    ).toEqual({ project: "proj-3", tier: "Enterprise", endpoint: "prod" });
  });
});

const RUNTIME_UA =
  "google-antigravity-sdk/0.0.0-dev python/3.12.9 antigravity/acp/1.5.0 (aidev_client; os_type=darwin; arch=arm64; auth_method=gateway; host_path=bb-probe/0; proxy_client=antigravity/sdk)";
const UPSTREAM_UA =
  "antigravity/acp/1.5.0 (aidev_client; os_type=darwin; arch=arm64; host_path=bb-probe/0; proxy_client=antigravity/sdk)";

async function piped(
  transform: TransformStream<Uint8Array, Uint8Array>,
  chunks: Uint8Array[],
): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(source.pipeThrough(transform)).text();
}

function sseData(text: string): unknown[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown);
}

describe("Gemini gateway translation", () => {
  it("unwraps each SSE event's response across any chunk boundary, keeping line endings", async () => {
    const wire =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"h\u00e9"}]}}]},"traceId":"t"}\r\n\r\n' +
      ": keep-alive\n\n" +
      'data: {"response":{"usageMetadata":{"totalTokenCount":3}}}\n\n';
    const bytes = new TextEncoder().encode(wire);
    const errors: string[] = [];
    const whole = await piped(unwrapSse((detail) => errors.push(detail)), [bytes]);
    expect(whole).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"h\u00e9"}]}}]}\r\n\r\n' +
        ": keep-alive\n\n" +
        'data: {"usageMetadata":{"totalTokenCount":3}}\n\n',
    );
    for (let cut = 1; cut < bytes.length; cut += 1)
      expect(
        await piped(unwrapSse(() => undefined), [bytes.slice(0, cut), bytes.slice(cut)]),
      ).toBe(whole);
    expect(errors).toEqual([]);
  });

  it("passes an in-stream error event on unchanged after reporting it", async () => {
    const event = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
    const errors: string[] = [];
    const out = await piped(unwrapSse((detail) => errors.push(detail)), [
      new TextEncoder().encode(`data: ${event}\r\n\r\n`),
    ]);
    expect(out).toBe(`data: ${event}\r\n\r\n`);
    expect(errors).toEqual([event]);
  });

  it("joins a mapped model id back the way the runtime's OAuth path names it", () => {
    expect(
      codeAssistModel("gemini-4-carbon", {
        contents: [],
        generationConfig: {
          temperature: 1,
          thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
        },
      }),
    ).toEqual({
      model: "gemini-4-carbon-high",
      request: {
        contents: [],
        generationConfig: { temperature: 1, thinkingConfig: { includeThoughts: true } },
      },
    });
    expect(
      codeAssistModel("gemini-3.1-pro-preview", {
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }).model,
    ).toBe("gemini-3.1-pro-low");
    const literal = { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
    expect(codeAssistModel("gemini-3-flash-preview", literal)).toEqual({
      model: "gemini-3-flash-preview",
      request: literal,
    });
    const minimal = { generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } } };
    expect(codeAssistModel("gemini-4-argon", minimal)).toEqual({
      model: "gemini-4-argon",
      request: minimal,
    });
    expect(codeAssistModel("gemini-3.1-flash-lite-image", { contents: [] }).model).toBe(
      "gemini-3.1-flash-image",
    );
    expect(
      codeAssistModel("gemini-4-carbon", {
        contents: [],
        generationConfig: { maxOutputTokens: 65535, thinkingConfig: { thinkingLevel: "high" } },
      }),
    ).toEqual({
      model: "gemini-4-carbon-high",
      request: { contents: [], generationConfig: { maxOutputTokens: 65535 } },
    });
  });

  it("drops models agentModelSorts leaves out, as the runtime does, unless there are no sorts", () => {
    const models = {
      ...MODELS_PAYLOAD.models,
      "gemini-unsorted": { displayName: "Unsorted" },
    };
    expect(codeAssistModels({ ...MODELS_PAYLOAD, models }).map((model) => model.id)).toEqual([
      "gemini-orchestrator",
      "gemini-4-carbon-high",
      "gemini-3.8-flash",
    ]);
    const expected = ["gemini-4-carbon-high", "gemini-3.8-flash", "gemini-orchestrator", "gemini-unsorted"];
    for (const agentModelSorts of [undefined, [], [{ groups: [] }]])
      expect(
        codeAssistModels({ models, ...(agentModelSorts === undefined ? {} : { agentModelSorts }) }).map(
          (model) => model.id,
        ),
      ).toEqual(expected);
    expect(codeAssistModels({ agentModelSorts: MODELS_PAYLOAD.agentModelSorts })).toEqual([]);
  });

  it("serves only antigravity-acp 1.5.0, and names the reason otherwise", () => {
    const ua = (value: string) => new Headers({ "user-agent": value });
    expect(geminiRuntimeRefusal(ua(RUNTIME_UA))).toBeNull();
    expect(geminiRuntimeRefusal(ua(RUNTIME_UA.replace("acp/1.5.0", "acp/1.6.0")))).toBe(
      "Gemini routing is not available: antigravity-acp 1.6.0 is installed, and the Account Pooler supports only 1.5.0.",
    );
    expect(geminiRuntimeRefusal(ua("curl/8.7.1"))).toBe(
      "Gemini routing is not available: the request is not from antigravity-acp.",
    );
    expect(geminiRuntimeRefusal(new Headers())).not.toBeNull();
    expect(geminiUpstreamUserAgent(ua(RUNTIME_UA))).toBe(UPSTREAM_UA);
  });
});

interface UpstreamCall {
  method: string;
  bearer: string;
  project: unknown;
  sessionId: unknown;
  endpoint?: "prod" | "daily";
  body?: unknown;
  url?: string;
  userAgent?: string;
  headerNames?: string[];
}

type StreamBehavior = (bearer: string) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  sse?: string[];
};

async function startGoogle(args: {
  projects: Record<string, string>;
  gcpTos?: string[];
  quotaFraction: Record<string, number>;
  extraBuckets?: unknown[];
  models?: unknown;
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
        const raw = Buffer.concat(chunks).toString("utf8");
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
        if (request.url === "/token") {
          const form = new URLSearchParams(raw);
          const refresh = form.get("refresh_token") ?? "";
          calls.push({ method: "token", bearer: refresh, project: null, sessionId: null });
          if (
            form.get("client_id") !== CLIENT.clientId ||
            form.get("client_secret") !== CLIENT.clientSecret ||
            !refresh.startsWith("refresh-")
          )
            send(400, { error: "invalid_grant" });
          else
            send(200, {
              access_token: refresh.slice("refresh-".length),
              expires_in: 3600,
              token_type: "Bearer",
            });
          return;
        }
        if (request.url === "/userinfo") {
          if (bearer.startsWith("tok-noemail")) {
            send(503, { error: "unavailable" });
            return;
          }
          send(200, { email: `${bearer.replace(/^tok-/u, "")}@example.com` });
          return;
        }
        const mount = /^\/(prod|daily)(\/.*)$/u.exec(String(request.url));
        if (mount === null) {
          calls.push({ method: String(request.url), bearer, project: null, sessionId: null });
          send(200, { ok: true });
          return;
        }
        const endpoint = mount[1] as "prod" | "daily";
        const apiPath = (mount[2] ?? "").replace(/\?.*$/u, "");
        const method = apiPath.replace(/^\/v1internal:/u, "");
        const body: Record<string, unknown> =
          raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
        const inner = (body.request ?? {}) as Record<string, unknown>;
        calls.push({
          method,
          bearer,
          project: body.project,
          sessionId: inner.sessionId,
          endpoint,
          body,
          url: String(request.url),
          userAgent: String(request.headers["user-agent"] ?? ""),
          headerNames: Object.keys(request.headers).sort(),
        });
        if (!apiPath.startsWith("/v1internal:")) {
          send(200, { ok: true });
          return;
        }
        if (method === "loadCodeAssist")
          send(200, {
            cloudaicompanionProject: args.projects[bearer],
            paidTier: (args.gcpTos ?? []).includes(bearer)
              ? { name: "Gemini Code Assist Enterprise", usesGcpTos: true }
              : { name: "Google AI Ultra" },
          });
        else if (method === "retrieveUserQuotaSummary")
          send(200, {
            buckets: [
              ...(args.extraBuckets ?? []),
              {
                bucketId: "gemini-3-pro",
                remainingFraction: args.quotaFraction[bearer] ?? 1,
                resetTime: "2100-01-01T00:00:00Z",
              },
            ],
          });
        else if (method === "fetchAvailableModels")
          send(200, args.models ?? MODELS_PAYLOAD);
        else if (method === "streamGenerateContent" || method === "generateContent") {
          const outcome = args.stream(bearer);
          if (outcome.status !== 200 || method === "generateContent") {
            send(outcome.status, outcome.body, outcome.headers);
            return;
          }
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream");
          for (const chunk of outcome.sse ?? [
            `data: ${JSON.stringify(outcome.body)}\r\n\r\n`,
          ])
            response.write(chunk);
          response.end();
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

const MODELS_PAYLOAD = {
  models: {
    "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576 },
    "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" },
    "gemini-orchestrator": { displayName: "Gemini Orchestrator" },
    "claude-opus-4-6": { displayName: "Claude Opus 4.6" },
    "gemini-retired": { displayName: "Retired", disabled: true },
    "gpt-oss-120b": { displayName: "GPT-OSS" },
  },
  agentModelSorts: [
    {
      groups: [
        { modelIds: ["gemini-orchestrator", "claude-opus-4-6", "gemini-4-carbon-high"] },
        { modelIds: ["gemini-retired", "gemini-3.8-flash", "gpt-oss-120b", "gemini-orchestrator"] },
      ],
    },
  ],
};

const TRANSPORT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "connection",
  "content-length",
  "host",
  "sec-fetch-mode",
  "transfer-encoding",
]);

async function createGeminiFixture(
  google: { url: string },
  homes: Record<string, ImportedGeminiCredentials>,
  options: {
    withCodex?: boolean;
    hostWorker?: "current" | "old";
    kv?: Record<string, unknown>;
    loginControl?: string;
    loginTimeoutMs?: number;
    runtimeGate?: Promise<void>;
  } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-gemini-"));
  const hostDataDir = await tempDir("bb-host-worker-");
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
    experimental_callHostRpc: async (call) => {
      if (call.method === "writeGeminiHome" || call.method === "pruneGeminiHomes") {
        if (options.hostWorker === "old")
          throw new Error(`unknown host rpc method "${call.method}"`);
      }
      if (call.method === "writeGeminiHome") {
        const input = call.input as { key: string };
        return {
          home: await writeGeminiHome({ dataDir: hostDataDir, key: input.key }),
        };
      }
      if (call.method === "pruneGeminiHomes") {
        const input = call.input as { keep: string[] };
        return {
          removed: await pruneGeminiHomes({ dataDir: hostDataDir, keep: input.keep }),
        };
      }
      throw new Error("This fixture has no Artifact proxy.");
    },
  });
  await host.bb.storage.kv.set("config", {
    anthropicUpstreamBaseUrl: google.url,
    codexUpstreamBaseUrl: google.url,
  });
  for (const [key, value] of Object.entries(options.kv ?? {}))
    await host.bb.storage.kv.set(key, value);
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    codexRefreshUrl: `${google.url}/oauth`,
    codexUsageUrl: `${google.url}/usage`,
    ...(options.withCodex === true
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
    geminiUserinfoUrl: `${google.url}/userinfo`,
    geminiUpstreamBaseUrls: {
      prod: `${google.url}/prod`,
      daily: `${google.url}/daily`,
    },
    ...(options.loginControl === undefined
      ? {}
      : {
          resolveGeminiRuntime: async () => {
            await options.runtimeGate;
            return {
              command: process.execPath,
              args: [FAKE_RUNTIME, options.loginControl as string],
            };
          },
          geminiLoginBrowser: {
            command: process.execPath,
            args: [FAKE_CHROME, options.loginControl],
          },
          ...(options.loginTimeoutMs === undefined
            ? {}
            : { geminiLoginTimeoutMs: options.loginTimeoutMs }),
        }),
    importGeminiCredentials: async (home?: string) => {
      requestedHomes.push(home);
      const found = home === undefined ? undefined : homes[home];
      if (found !== undefined) return found;
      const written =
        home === undefined
          ? null
          : await fs
              .readFile(path.join(home, "antigravity-acp", "acp_token.json"), "utf8")
              .catch(() => null);
      if (written === null) throw new Error("no fake login for that home");
      return creds((JSON.parse(written) as { access: string }).access);
    },
  })(host.bb);
  const service = host.harness.behavior.runService("hub");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  await vi.waitFor(async () => {
    expect(
      statusSchema.parse(await host.harness.behavior.callRpc("status.get", null))
        .accepting,
    ).toBe(true);
  });
  return { host, requestedHomes, dataDir, hostDataDir };
}

function creds(access: string): ImportedGeminiCredentials {
  return { refreshToken: `refresh-${access}`, client: CLIENT, projectId: null };
}

type GeminiHost = Awaited<ReturnType<typeof createGeminiFixture>>["host"];

function resolveGeminiEnv(host: GeminiHost, threadId: string | null = THREAD) {
  return host.harness.behavior.resolveProviderEnv(GEMINI_PROVIDER_ID, {
    threadId,
    projectId: threadId === null ? null : "project-one",
    hostId: "host-one",
  });
}

const GENERATE_ROUTE =
  "/gemini/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent";

async function geminiEnv(host: GeminiHost, threadId = THREAD) {
  const entries = await resolveGeminiEnv(host, threadId);
  const byName = new Map(entries.map((entry) => [entry.name, entry.value]));
  const home = byName.get("GEMINI_HOME");
  const token = byName.get("AGY_GATEWAY_API_KEY");
  if (typeof home !== "string" || typeof token !== "string")
    throw new Error("Gemini env missing.");
  return { token, home, byName, entries };
}

function runtimeCall(
  host: GeminiHost,
  token: string,
  options: { method?: "GET" | "POST"; path?: string; body?: unknown; userAgent?: string } = {},
) {
  const method = options.method ?? "POST";
  const response = host.harness.behavior.fetchHttp(method, options.path ?? `${GENERATE_ROUTE}?alt=sse`, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": options.userAgent ?? RUNTIME_UA,
    },
    ...(method === "GET"
      ? {}
      : { body: JSON.stringify(options.body ?? { contents: [], sessionId: "s" }) }),
  });
  upstreams.push(async () => {
    const settled = await response.catch(() => null);
    if (settled !== null && !settled.bodyUsed) await settled.body?.cancel();
  });
  return response;
}

async function addGemini(host: GeminiHost, home: string, priority: number) {
  return (await host.harness.behavior.callRpc("account.add", {
    provider: "gemini",
    source: { kind: "import", home },
    label: null,
    priority,
  })) as { id: string };
}

describe("Gemini account pool", () => {
  async function twoAccounts(
    stream: StreamBehavior,
    fractions: Record<string, number> = {},
    extraBuckets?: unknown[],
  ) {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a", "tok-b": "proj-b" },
      quotaFraction: fractions,
      ...(extraBuckets === undefined ? {} : { extraBuckets }),
      stream,
    });
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/a": creds("tok-a"),
      "/homes/b": creds("tok-b"),
    });
    const a = await addGemini(fixture.host, "/homes/a", 0);
    const b = await addGemini(fixture.host, "/homes/b", 100);
    const env = await geminiEnv(fixture.host);
    const post = (sessionId = "session-1", token = env.token) =>
      runtimeCall(fixture.host, token, { body: { contents: [], sessionId } });
    return { google, fixture, env, post, ids: { a: a.id, b: b.id } };
  }

  it("adds accounts from separate homes and records each one's email and project", async () => {
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
    expect(
      google.calls.filter((call) => call.method === "token").map((call) => call.bearer).sort(),
    ).toEqual(["refresh-tok-a", "refresh-tok-b"]);
    expect(
      [...new Set(google.calls.filter((call) => call.method === "loadCodeAssist").map((call) => call.bearer))].sort(),
    ).toEqual(["tok-a", "tok-b"]);
    await expect(addGemini(fixture.host, "/homes/a", 5)).rejects.toThrow();
  });

  it("refuses an import whose Google email cannot be read, so a login never enters twice", async () => {
    const google = await startGoogle({
      projects: { "tok-noemail": "proj-n", "tok-a": "proj-a" },
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/n": creds("tok-noemail"),
      "/homes/a": creds("tok-a"),
    });
    const secretFiles = async () =>
      (
        await fs.readdir(path.join(fixture.dataDir, "plugins"), {
          recursive: true,
          withFileTypes: true,
        })
      )
        .filter((entry) => entry.isFile() && entry.parentPath.includes(`${path.sep}secrets`))
        .map((entry) => path.join(entry.parentPath, entry.name));
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(addGemini(fixture.host, "/homes/n", attempt)).rejects.toThrow(
        /could not read this Google account's email/u,
      );
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.accounts.filter((account) => account.provider === "gemini")).toEqual([]);
    expect(await fixture.host.bb.storage.kv.get("accounts:gemini:v1")).toBeUndefined();
    expect(google.calls.filter((call) => call.method === "loadCodeAssist")).toEqual([]);
    expect(await secretFiles()).toEqual([]);
    await addGemini(fixture.host, "/homes/a", 0);
    expect(await secretFiles()).toHaveLength(1);
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
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/a": creds("tok-a"),
      "/homes/b": creds("tok-b"),
      "/homes/c": creds("tok-c"),
    });
    for (const [home, priority] of [
      ["/homes/a", 100],
      ["/homes/b", 200],
      ["/homes/c", 300],
    ] as const)
      await addGemini(fixture.host, home, priority);
    const env = await geminiEnv(fixture.host);
    const response = await runtimeCall(fixture.host, env.token, {
      body: { contents: [], sessionId: "s3" },
    });
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
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/c": creds("tok-c"),
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
    expect(login.stderr).toContain("No antigravity-acp agent is configured");
  });

  it("signs a Google account in with --login, adds it, and refuses the same email twice", async () => {
    const google = await startGoogle({
      projects: { "tok-c": "proj-c", "tok-d": "proj-d" },
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    upstreams.push(google.close);
    const control = await tempDir("bb-gemini-login-control-");
    const fixture = await createGeminiFixture(
      google,
      { "/homes/c": creds("tok-c") },
      { loginControl: control },
    );
    const cli = fixture.host.harness.behavior;
    const signIn = async (access: string, extra: string[] = []) => {
      await fs.rm(path.join(control, "approve"), { force: true });
      await fs.rm(path.join(control, "browser.json"), { force: true });
      await fs.writeFile(
        path.join(control, "config.json"),
        JSON.stringify({ version: "1.5.0", token: { access } }),
      );
      const running = cli.runCli([
        "account",
        "add",
        "--provider",
        "gemini",
        "--login",
        ...extra,
      ]);
      await waitForFile(path.join(control, "browser.json"));
      await fs.writeFile(path.join(control, "approve"), "");
      return running;
    };

    const added = await signIn("tok-d", ["--label", "ultra-d", "--priority", "7"]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain(
      "Signed in through a separate, temporary Chrome profile (not your own Chrome profile), opened on https://accounts.google.com/",
    );
    expect(added.stdout).toMatch(/\nAdded ultra-d \(/u);
    expect(added.stdout).toContain("the temporary profile and sign-in folder were deleted");
    const browser = JSON.parse(
      await fs.readFile(path.join(control, "browser.json"), "utf8"),
    ) as { args: string[]; pid: number };
    expect(browser.args).toContain("--use-mock-keychain");
    expect(isAlive(browser.pid)).toBe(false);

    await cli.runCli(["account", "add", "--provider", "gemini", "--import", "--home", "/homes/c"]);
    const duplicate = await signIn("tok-c");
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain("already in the account pool");

    const listed = JSON.parse(
      (await cli.runCli(["account", "list", "--json"])).stdout,
    ) as { accounts: Array<{ provider: string; label: string; priority: number }> };
    const gemini = listed.accounts.filter((account) => account.provider === "gemini");
    expect(gemini).toHaveLength(2);
    expect(gemini.map((account) => account.label)).toContain("ultra-d");
    expect(gemini.find((account) => account.label === "ultra-d")?.priority).toBe(7);
    const loginRoot = path.join(fixture.dataDir, "plugins", "account-pool", "gemini-login");
    expect(await fs.readdir(loginRoot).catch(() => [])).toEqual([]);
  });

  it("returns at once and starts nothing when add --login is interrupted while the runtime is still being resolved", async () => {
    const google = await startGoogle({
      projects: {},
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    upstreams.push(google.close);
    const control = await tempDir("bb-gemini-login-control-");
    await fs.writeFile(
      path.join(control, "config.json"),
      JSON.stringify({ version: "1.5.0", token: { access: "tok-f" } }),
    );
    let resolved = false;
    let release = () => {};
    const runtimeGate = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });
    const fixture = await createGeminiFixture(
      google,
      {},
      { loginControl: control, runtimeGate },
    );
    const cli = fixture.host.harness.behavior;
    const abort = new AbortController();
    const running = cli.runCli(["account", "add", "--provider", "gemini", "--login"], {
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    const result = await running;
    expect(resolved).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cancelled");

    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await fs.readdir(control)).toEqual(["config.json"]);
    const loginRoot = path.join(fixture.dataDir, "plugins", "account-pool", "gemini-login");
    expect(await fs.readdir(loginRoot).catch(() => [])).toEqual([]);
    expect(await accountSecretFiles(fixture.dataDir)).toEqual([]);
    const listed = JSON.parse(
      (await cli.runCli(["account", "list", "--json"])).stdout,
    ) as { accounts: Array<{ provider: string }> };
    expect(listed.accounts.filter((account) => account.provider === "gemini")).toEqual([]);
  });

  for (const ending of ["interrupted", "timed out"] as const) {
    it(`adds nothing and leaves nothing behind when add --login is ${ending}`, async () => {
      const google = await startGoogle({
        projects: { "tok-e": "proj-e" },
        quotaFraction: {},
        stream: () => ({ status: 200, body: OK_BODY }),
      });
      upstreams.push(google.close);
      const control = await tempDir("bb-gemini-login-control-");
      await fs.writeFile(
        path.join(control, "config.json"),
        JSON.stringify({ version: "1.5.0", token: { access: "tok-e" } }),
      );
      const fixture = await createGeminiFixture(
        google,
        {},
        {
          loginControl: control,
          ...(ending === "timed out" ? { loginTimeoutMs: 300 } : {}),
        },
      );
      const cli = fixture.host.harness.behavior;
      const abort = new AbortController();
      const running = cli.runCli(
        ["account", "add", "--provider", "gemini", "--login", "--label", "never"],
        { signal: abort.signal },
      );
      await waitForFile(path.join(control, "browser.json"));
      if (ending === "interrupted") abort.abort();
      const result = await running;

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "The temporary Chrome profile and sign-in folder were deleted.",
      );
      expect(result.stderr).toContain("https://accounts.google.com/");
      expect(result.stderr).not.toContain("tok-e");
      const listed = JSON.parse(
        (await cli.runCli(["account", "list", "--json"])).stdout,
      ) as { accounts: Array<{ provider: string }> };
      expect(listed.accounts.filter((account) => account.provider === "gemini")).toEqual([]);
      expect(await accountSecretFiles(fixture.dataDir)).toEqual([]);
      const loginRoot = path.join(fixture.dataDir, "plugins", "account-pool", "gemini-login");
      expect(await fs.readdir(loginRoot).catch(() => [])).toEqual([]);
      const browser = JSON.parse(
        await fs.readFile(path.join(control, "browser.json"), "utf8"),
      ) as { pid: number };
      const runtime = JSON.parse(
        await fs.readFile(path.join(control, "env.json"), "utf8"),
      ) as { pid: number };
      expect(isAlive(browser.pid)).toBe(false);
      expect(isAlive(runtime.pid)).toBe(false);
    });
  }

  it("points antigravity-acp at the hub with env only, through a home that holds no credential", async () => {
    const { env, fixture } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    expect(env.entries.map((entry) => entry.name).sort()).toEqual([
      "AGY_ACP_ENABLE_GATEWAY_AUTH",
      "AGY_ACP_FORCE_FILE_STORAGE",
      "AGY_GATEWAY_API_KEY",
      "AGY_GATEWAY_URL",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
      "BB_ACCOUNT_POOL_PARENT_URL",
      "GEMINI_HOME",
    ]);
    expect(env.byName.get("AGY_ACP_FORCE_FILE_STORAGE")).toBe("1");
    expect(env.byName.get("AGY_ACP_ENABLE_GATEWAY_AUTH")).toBe("1");
    expect(env.byName.get("AGY_GATEWAY_URL")).toEqual({
      serverPath: "/api/v1/plugins/account-pool/http/gemini",
    });
    expect(env.home).toBe(path.join(fixture.hostDataDir, "gemini-homes", THREAD));
    const runtimeDir = path.join(env.home, "antigravity-acp");
    expect(await fs.readdir(runtimeDir)).toEqual(["settings.json"]);
    const written = await fs.readFile(path.join(runtimeDir, "settings.json"), "utf8");
    expect(JSON.parse(written)).toEqual({ auth: { type: "gateway" } });
    for (const secret of ["tok-a", "tok-b", "refresh-tok", CLIENT.clientSecret, env.token])
      expect(written).not.toContain(secret);
    expect(JSON.stringify(env.entries)).not.toMatch(/tok-a|tok-b|refresh-tok|agy-secret/u);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth(GEMINI_PROVIDER_ID, {
        hostId: "host-one",
      }),
    ).resolves.toMatchObject({ label: "Proxied" });
  });

  it("gives the runtime only the hub to call, and never sends the hub token to Google", async () => {
    const { env, fixture, google, post } = await twoAccounts(() => ({
      status: 200,
      body: OK_BODY,
    }));
    for (const threadId of [THREAD, null]) {
      const entries = await resolveGeminiEnv(fixture.host, threadId);
      for (const entry of entries) {
        if (typeof entry.value === "string")
          expect(entry.value).not.toMatch(/^[a-z]+:\/\//iu);
        else
          expect(entry.value.serverPath).toMatch(
            /^\/api\/v1\/plugins\/account-pool\/http(?:\/|$)/u,
          );
      }
    }
    await (await post()).text();
    await (
      await runtimeCall(fixture.host, env.token, {
        path: "/gemini/v1beta/models/gemini-3.1-pro-preview:generateContent",
      })
    ).text();
    await (
      await runtimeCall(fixture.host, env.token, { method: "GET", path: "/gemini/v1beta/models" })
    ).text();
    await (
      await runtimeCall(fixture.host, env.token, { method: "GET", path: "/gemini/v1/models" })
    ).text();
    const served = google.calls.filter((call) => call.endpoint !== undefined);
    expect(served.map((call) => call.method)).toEqual(
      expect.arrayContaining(["streamGenerateContent", "generateContent", "fetchAvailableModels"]),
    );
    for (const call of google.calls) {
      expect(call.bearer).not.toBe(env.token);
      expect(JSON.stringify(call.body ?? null)).not.toContain(env.token);
    }
  });

  it("sends a turn as the runtime's own Code Assist call and unwraps the stream", async () => {
    const { google, post } = await twoAccounts(() => ({
      status: 200,
      body: OK_BODY,
      sse: [
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]},"traceId":"t1"}\r\n\r\n',
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"totalTokenCount":3}}}\r\n\r\n',
      ],
    }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sseData(await response.text())).toEqual([
      { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
      {
        candidates: [{ content: { parts: [{ text: "lo" }] } }],
        usageMetadata: { totalTokenCount: 3 },
      },
    ]);
    const [call, ...rest] = google.calls.filter(
      (entry) => entry.method === "streamGenerateContent",
    );
    expect(rest).toEqual([]);
    expect(call?.url).toBe("/daily/v1internal:streamGenerateContent?alt=sse");
    expect(call?.body).toEqual({
      model: "gemini-3.1-pro-preview",
      project: "proj-a",
      request: { contents: [], sessionId: "session-1" },
    });
    expect(call?.userAgent).toBe(UPSTREAM_UA);
    expect(call?.headerNames?.filter((name) => !TRANSPORT_HEADERS.has(name))).toEqual([
      "authorization",
      "content-type",
      "user-agent",
    ]);
  });

  it("joins a mapped model back and unwraps a unary reply", async () => {
    const { google, fixture, env } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    const response = await runtimeCall(fixture.host, env.token, {
      path: "/gemini/v1beta/models/gemini-4-carbon:generateContent",
      body: {
        contents: [],
        generationConfig: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_BODY.response);
    const call = google.calls.find((entry) => entry.method === "generateContent");
    expect(call?.url).toBe("/daily/v1internal:generateContent");
    expect(call?.body).toEqual({
      model: "gemini-4-carbon-high",
      project: "proj-a",
      request: {
        contents: [],
        generationConfig: { thinkingConfig: { includeThoughts: true } },
      },
    });
  });

  it("lists the routed account's Gemini models in both shapes and routes each new id", async () => {
    const { google, fixture, env } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    const newModel = "/gemini/v1beta/models/gemini-orchestrator:streamGenerateContent";
    await expect(runtimeCall(fixture.host, env.token, { path: newModel })).rejects.toThrow(
      /no http route/u,
    );
    const v1beta = await runtimeCall(fixture.host, env.token, {
      method: "GET",
      path: "/gemini/v1beta/models?pageSize=1000",
    });
    expect(v1beta.status).toBe(200);
    expect(await v1beta.json()).toEqual({
      models: [
        {
          name: "models/gemini-orchestrator",
          displayName: "Gemini Orchestrator",
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        },
        {
          name: "models/gemini-4-carbon-high",
          displayName: "Gemini 4 Carbon (High)",
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        },
        {
          name: "models/gemini-3.8-flash",
          displayName: "Gemini 3.8 Flash",
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        },
      ],
    });
    const v1 = await runtimeCall(fixture.host, env.token, {
      method: "GET",
      path: "/gemini/v1/models",
    });
    expect(await v1.json()).toEqual({
      object: "list",
      data: [
        { id: "gemini-orchestrator", object: "model" },
        { id: "gemini-4-carbon-high", object: "model" },
        { id: "gemini-3.8-flash", object: "model" },
      ],
    });
    const lists = google.calls.filter((call) => call.method === "fetchAvailableModels");
    expect(lists.map((call) => [call.bearer, call.body])).toEqual([
      ["tok-a", { project: "proj-a" }],
      ["tok-a", { project: "proj-a" }],
    ]);
    const routed = await runtimeCall(fixture.host, env.token, {
      path: `${newModel}?alt=sse`,
    });
    expect(routed.status).toBe(200);
    await routed.text();
  });

  it("keeps the ids each account served, and routes them after a restart with no model list", async () => {
    const { google, fixture, env, ids } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    await (
      await runtimeCall(fixture.host, env.token, { method: "GET", path: "/gemini/v1beta/models" })
    ).text();
    await vi.waitFor(async () => {
      expect(await fixture.host.bb.storage.kv.get("gemini-served-models:v1")).toEqual({
        [ids.a]: ["gemini-orchestrator", "gemini-4-carbon-high", "gemini-3.8-flash"],
      });
    });

    const restarted = await createGeminiFixture(
      google,
      { "/homes/a": creds("tok-a") },
      {
        kv: {
          "gemini-served-models:v1": {
            [ids.a]: ["gemini-orchestrator"],
            "00000000-0000-4000-8000-000000000001": [
              "gemini-4-hydrogen-high",
              "gemini-4-hydrogen-xhigh",
              "gemini-pro-orchestrator",
              "gemini-pro-orchestrator-argon",
            ],
          },
        },
      },
    );
    await addGemini(restarted.host, "/homes/a", 0);
    const restartedEnv = await geminiEnv(restarted.host);
    const lists = google.calls.filter((call) => call.method === "fetchAvailableModels").length;
    for (const model of ["gemini-4-hydrogen-high", "gemini-pro-orchestrator-argon", "gemini-orchestrator"]) {
      const response = await runtimeCall(restarted.host, restartedEnv.token, {
        path: `/gemini/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(google.calls.filter((call) => call.method === "fetchAvailableModels")).toHaveLength(lists);
    expect(
      google.calls
        .filter((call) => call.method === "streamGenerateContent")
        .map((call) => (call.body as { model: string }).model)
        .slice(-3),
    ).toEqual(["gemini-4-hydrogen-high", "gemini-pro-orchestrator-argon", "gemini-orchestrator"]);
  });

  it("refuses an unsupported runtime by name, never forwarding it, and clears once 1.5.0 calls", async () => {
    const { google, fixture, env } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    const health = () =>
      fixture.host.harness.behavior.resolveProviderEnvHealth(GEMINI_PROVIDER_ID, {
        hostId: "host-one",
      });
    const refused = await runtimeCall(fixture.host, env.token, {
      userAgent: RUNTIME_UA.replace("acp/1.5.0", "acp/1.6.0"),
    });
    expect(refused.status).toBe(400);
    const reason =
      "Gemini routing is not available: antigravity-acp 1.6.0 is installed, and the Account Pooler supports only 1.5.0.";
    expect(await refused.json()).toEqual({
      error: { code: 400, message: reason, status: "INVALID_ARGUMENT" },
    });
    await expect(health()).resolves.toEqual(
      expect.objectContaining({ label: "Not available", statusMessage: reason }),
    );
    const foreign = await runtimeCall(fixture.host, env.token, { userAgent: "curl/8.7.1" });
    expect(foreign.status).toBe(400);
    expect(
      google.calls.filter(
        (call) =>
          call.endpoint !== undefined &&
          !["loadCodeAssist", "retrieveUserQuotaSummary"].includes(call.method),
      ),
    ).toEqual([]);
    const accepted = await runtimeCall(fixture.host, env.token);
    expect(accepted.status).toBe(200);
    await accepted.text();
    await expect(health()).resolves.toMatchObject({ label: "Proxied" });
  });

  it("holds an account whose stream reports QUOTA_EXHAUSTED and fails the next request over", async () => {
    const { google, post, fixture } = await twoAccounts((bearer) =>
      bearer === "tok-a"
        ? {
            status: 200,
            body: null,
            sse: [
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"par"}]}}]}}\r\n\r\n',
              `data: ${JSON.stringify({ error: QUOTA_BODY.error })}\r\n\r\n`,
            ],
          }
        : { status: 200, body: OK_BODY },
    );
    const first = await post("session-mid");
    expect(first.status).toBe(200);
    expect(sseData(await first.text())).toEqual([
      { candidates: [{ content: { parts: [{ text: "par" }] } }] },
      { error: QUOTA_BODY.error },
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    const a = status.accounts.find((account) => account.email === "a@example.com");
    expect(a?.usageRestriction?.reason).toBe("quota_exhausted");
    const second = await post("session-mid");
    expect(sseData(await second.text())).toEqual([OK_BODY.response]);
    expect(
      google.calls
        .filter((call) => call.method === "streamGenerateContent")
        .map((call) => [call.bearer, call.project]),
    ).toEqual([
      ["tok-a", "proj-a"],
      ["tok-b", "proj-b"],
    ]);
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

  it("identifies as Antigravity and sends each account to the endpoint its tier is served on", async () => {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a", "tok-e": "proj-e" },
      gcpTos: ["tok-e"],
      quotaFraction: {},
      stream: (bearer) =>
        bearer === "tok-a"
          ? { status: 429, body: QUOTA_BODY }
          : { status: 200, body: OK_BODY },
    });
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(google, {
      "/homes/a": creds("tok-a"),
      "/homes/e": creds("tok-e"),
    });
    await addGemini(fixture.host, "/homes/a", 0);
    await addGemini(fixture.host, "/homes/e", 100);
    const loads = google.calls.filter((call) => call.method === "loadCodeAssist");
    expect(loads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(loads.map((call) => call.endpoint))).toEqual(new Set(["prod"]));
    for (const call of loads)
      expect(call.body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
    const env = await geminiEnv(fixture.host);
    const response = await runtimeCall(fixture.host, env.token, {
      body: { contents: [], sessionId: "ep" },
    });
    expect(response.status).toBe(200);
    expect(
      google.calls
        .filter((call) => call.method === "streamGenerateContent")
        .map((call) => [call.bearer, call.endpoint]),
    ).toEqual([
      ["tok-a", "daily"],
      ["tok-e", "prod"],
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    for (const account of status.accounts)
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: account.id,
      });
    expect(
      [
        ...new Set(
          google.calls
            .filter((call) => call.method === "retrieveUserQuotaSummary")
            .map((call) => `${call.bearer} ${call.endpoint}`),
        ),
      ].sort(),
    ).toEqual(["tok-a daily", "tok-e prod"]);
  });

  it("fails over on RESOURCE_EXHAUSTED and rewrites the project to the next account", async () => {
    const { google, post } = await twoAccounts((bearer) =>
      bearer === "tok-a"
        ? { status: 429, body: QUOTA_BODY }
        : { status: 200, body: OK_BODY },
    );
    const response = await post();
    expect(response.status).toBe(200);
    expect(sseData(await response.text())).toEqual([OK_BODY.response]);
    const stream = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(stream.map((call) => [call.bearer, call.project])).toEqual([
      ["tok-a", "proj-a"],
      ["tok-b", "proj-b"],
    ]);
    await (await post("session-2")).text();
    const after = google.calls.filter((call) => call.method === "streamGenerateContent");
    expect(after.slice(2).map((call) => call.bearer)).toEqual(["tok-b"]);
  });

  it("keeps an explicitly chosen account even when it is out of quota", async () => {
    const { google, fixture, ids } = await twoAccounts(() => ({ status: 429, body: QUOTA_BODY }));
    const configure =
      fixture.host.harness.registrations.hooks["experimental_thread.configure"];
    if (configure === null) throw new Error("configure hook missing");
    const pinned = "thr_pinned2345";
    await configure({
      thread: { id: pinned, providerId: GEMINI_PROVIDER_ID },
      data: { provider: "gemini", accountId: ids.b },
    });
    const env = await geminiEnv(fixture.host, pinned);
    const response = await runtimeCall(fixture.host, env.token, {
      body: { contents: [], sessionId: "p1" },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(QUOTA_BODY);
    expect(
      google.calls.filter((call) => call.method === "streamGenerateContent").map((call) => call.bearer),
    ).toEqual(["tok-b"]);
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
    expect((await post("s-capacity-2")).status).toBe(200);
  });

  it("returns the last Google error when every account is out", async () => {
    const { post } = await twoAccounts(() => ({ status: 429, body: QUOTA_BODY }));
    const response = await post();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(QUOTA_BODY);
    const unauthorized = await post("s-bad", "not-a-hub-token");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: {
        code: 401,
        message: "Invalid Account Pooler bearer token.",
        status: "UNAUTHENTICATED",
      },
    });
  });

  it("reads usage per account from retrieveUserQuotaSummary", async () => {
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
      google.calls.filter((call) => call.method === "retrieveUserQuotaSummary").map((call) => call.project).sort(),
    ).toEqual(expect.arrayContaining(["proj-a", "proj-b"]));
  });

  it("keeps serving from an account whose only exhausted bucket is a third-party model", async () => {
    const { fixture, google, post } = await twoAccounts(
      () => ({ status: 200, body: OK_BODY }),
      { "tok-a": 0.5 },
      [{ bucketId: "claude-opus-4-5", remainingFraction: 0, resetTime: "2100-01-01T00:00:00Z" }],
    );
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    for (const account of status.accounts)
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: account.id,
      });
    expect((await post("s-third-party")).status).toBe(200);
    expect(
      google.calls.filter((call) => call.method === "streamGenerateContent").map((call) => call.bearer),
    ).toEqual(["tok-a"]);
  });

  it("removes a thread's home once its route is gone", async () => {
    const { fixture, env } = await twoAccounts(() => ({ status: 200, body: OK_BODY }));
    await fixture.host.harness.behavior.resolveProviderEnv(GEMINI_PROVIDER_ID, {
      threadId: null,
      projectId: null,
      hostId: "host-one",
    });
    await fs.rm(path.join(fixture.hostDataDir, "gemini-homes", "thr_expired234"), {
      recursive: true,
      force: true,
    });
    await writeGeminiHome({ dataDir: fixture.hostDataDir, key: "thr_expired234" });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-fake-claude" },
      label: "Claude fake",
      priority: 50,
    });
    await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "thr_kaude23456",
      projectId: "project-one",
      hostId: "host-one",
    });
    await vi.waitFor(async () => {
      expect(
        (await fs.readdir(path.join(fixture.hostDataDir, "gemini-homes"))).sort(),
      ).toEqual(["catalog", THREAD].sort());
    });
    await expect(fs.stat(env.home)).resolves.toBeTruthy();
  });
});

describe("Gemini on a host whose bb predates Gemini homes", () => {
  async function oldHost() {
    const google = await startGoogle({
      projects: { "tok-a": "proj-a" },
      quotaFraction: {},
      stream: () => ({ status: 200, body: OK_BODY }),
    });
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(
      google,
      { "/homes/a": creds("tok-a") },
      { withCodex: true, hostWorker: "old" },
    );
    const gemini = await addGemini(fixture.host, "/homes/a", 0);
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "import" },
      label: null,
      priority: 60,
    });
    return { fixture, gemini };
  }

  it("starts an automatic thread on the local login and says why in health", async () => {
    const { fixture } = await oldHost();
    const entries = await resolveGeminiEnv(fixture.host);
    expect(entries.map((entry) => entry.name)).not.toContain("GEMINI_HOME");
    expect(entries.map((entry) => entry.name)).not.toContain("AGY_GATEWAY_URL");
    expect(entries.map((entry) => entry.name)).not.toContain("AGY_GATEWAY_API_KEY");
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth(GEMINI_PROVIDER_ID, {
        hostId: "host-one",
      }),
    ).resolves.toMatchObject({
      label: "Not available",
      statusMessage: expect.stringContaining("not available on this machine"),
    });
    const codex = await fixture.host.harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_cdex234567",
      projectId: "project-one",
      hostId: "host-one",
    });
    expect(codex.map((entry) => entry.name)).toContain("CODEX_POOL_AUTH_TOKEN");
  });

  it("refuses to start a thread pinned to a Gemini account instead of switching it", async () => {
    const { fixture, gemini } = await oldHost();
    const configure =
      fixture.host.harness.registrations.hooks["experimental_thread.configure"];
    if (configure === null) throw new Error("configure hook missing");
    await configure({
      thread: { id: THREAD, providerId: GEMINI_PROVIDER_ID },
      data: { provider: "gemini", accountId: gemini.id },
    });
    await expect(resolveGeminiEnv(fixture.host)).rejects.toThrow(
      /not available on this machine/u,
    );
  });

  it("routes again once the host worker restarts on a build that has them", async () => {
    const { fixture } = await oldHost();
    expect((await resolveGeminiEnv(fixture.host)).map((entry) => entry.name)).not.toContain(
      "GEMINI_HOME",
    );
    const calls = () =>
      fixture.host.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "writeGeminiHome",
      ).length;
    const before = calls();
    await resolveGeminiEnv(fixture.host, "thr_secnd23456");
    expect(calls()).toBe(before);
    await fixture.host.harness.behavior.experimental_emitHostWorkerExit("host-one");
    await resolveGeminiEnv(fixture.host, "thr_third23456");
    expect(calls()).toBe(before + 1);
  });
});

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
    upstreams.push(google.close);
    const fixture = await createGeminiFixture(
      google,
      {
        "/homes/a": creds("tok-a"),
        "/homes/b": creds("tok-b"),
      },
      { withCodex: true },
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
    const response = await runtimeCall(fixture.host, env.token, {
      body: { contents: [], sessionId: "s1" },
    });
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
    const geminiRows = (await kv.get("accounts:gemini:v1")) as Array<{
      provider: string;
    }>;
    expect(geminiRows.map((row) => row.provider)).toEqual(["gemini", "gemini"]);
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
    await claudeResponse.text();
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
    await codexResponse.text();
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
