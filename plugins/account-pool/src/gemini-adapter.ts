import { z } from "zod";
import type {
  AccountQuota,
  AccountSecret,
  LimitWindow,
  LimitWindowSlot,
} from "./contracts.js";
import {
  importGeminiCredentials,
  type ImportedGeminiCredentials,
} from "./gemini-credentials.js";
import {
  OAuthRefreshError,
  TransientOAuthRefreshError,
  filterRequestHeaders,
  oauthSecretDueForRefresh,
  parseOAuthRefreshResponse,
  type ProviderAdapter,
} from "./provider-adapter.js";
import { retryAfterMilliseconds } from "./quota.js";

// Refreshing a gemini-cli token needs the OAuth client gemini-cli itself signs
// in with. It is not stored here; the owner supplies it (BB_GEMINI_OAUTH_CLIENT_ID
// and BB_GEMINI_OAUTH_CLIENT_SECRET, or the plugin option) so no client secret
// lives in source.
export interface GeminiOAuthClient {
  clientId: string;
  clientSecret: string;
}

export function geminiOAuthClientFromEnv(
  env: Record<string, string | undefined>,
): GeminiOAuthClient | undefined {
  const clientId = env.BB_GEMINI_OAUTH_CLIENT_ID;
  const clientSecret = env.BB_GEMINI_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export const DEFAULT_GEMINI_REFRESH_URL = "https://oauth2.googleapis.com/token";
export const DEFAULT_GEMINI_UPSTREAM_BASE_URL =
  "https://cloudcode-pa.googleapis.com";
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_WINDOW_MS = 60_000;
const DEFAULT_QUOTA_HOLD_MS = 10 * 60 * 1_000;

const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-goog-api-client",
]);

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

const tierSchema = z
  .object({ id: z.string().nullish(), name: z.string().nullish() })
  .passthrough()
  .nullish();

const loadCodeAssistSchema = z
  .object({
    cloudaicompanionProject: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .nullish(),
    currentTier: tierSchema,
    paidTier: tierSchema,
  })
  .passthrough();

const quotaBucketSchema = z
  .object({
    modelId: z.string().nullish(),
    remainingFraction: z.number().nullish(),
    resetTime: z.string().nullish(),
  })
  .passthrough();

const retrieveUserQuotaSchema = z
  .object({ buckets: z.array(quotaBucketSchema).nullish() })
  .passthrough();

export interface GeminiProjectInfo {
  project: string | null;
  tier: string | null;
}

export function parseLoadCodeAssist(payload: unknown): GeminiProjectInfo | null {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success) return null;
  const raw = parsed.data.cloudaicompanionProject;
  const project = typeof raw === "string" ? raw : (raw?.id ?? null);
  return {
    project: project === null || project === "" ? null : project,
    tier:
      parsed.data.paidTier?.name ?? parsed.data.currentTier?.name ?? null,
  };
}

/** Parses a protobuf-style duration such as "3600s", "1h2m3.5s" or "250ms". */
export function parseGoogleDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  let total = 0;
  let matched = false;
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gu)) {
    matched = true;
    const amount = Number(part[1]);
    total +=
      amount *
      (part[2] === "h"
        ? 3_600_000
        : part[2] === "m"
          ? 60_000
          : part[2] === "s"
            ? 1_000
            : 1);
  }
  return matched ? Math.round(total) : null;
}

const NON_QUOTA_REASONS = new Set(["MODEL_CAPACITY_EXHAUSTED"]);

/**
 * Google signals quota exhaustion in the response body, not in headers.
 * `RESOURCE_EXHAUSTED` with a quota reason means this account is out; model
 * capacity exhaustion is shared Google-side load and says nothing about the
 * account.
 */
export function geminiQuotaRejection(
  detail: string,
  now: number,
): { reason: string; resetAt: number; message: string } | null {
  let message = detail;
  let status: unknown;
  let reason: string | null = null;
  let delayMs: number | null = null;
  try {
    const parsed: unknown = JSON.parse(detail);
    const error =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? parsed.error
        : null;
    if (typeof error === "object" && error !== null) {
      status = "status" in error ? error.status : undefined;
      if ("message" in error && typeof error.message === "string")
        message = error.message;
      const details =
        "details" in error && Array.isArray(error.details) ? error.details : [];
      for (const entry of details as unknown[]) {
        if (typeof entry !== "object" || entry === null) continue;
        if ("reason" in entry && typeof entry.reason === "string")
          reason = entry.reason;
        if ("retryDelay" in entry)
          delayMs = parseGoogleDuration(entry.retryDelay) ?? delayMs;
        if (
          "metadata" in entry &&
          typeof entry.metadata === "object" &&
          entry.metadata !== null &&
          "quotaResetDelay" in entry.metadata
        )
          delayMs = parseGoogleDuration(entry.metadata.quotaResetDelay) ?? delayMs;
      }
    }
  } catch {
    status = detail.includes("RESOURCE_EXHAUSTED")
      ? "RESOURCE_EXHAUSTED"
      : undefined;
    reason = detail.includes("MODEL_CAPACITY_EXHAUSTED")
      ? "MODEL_CAPACITY_EXHAUSTED"
      : null;
  }
  if (status !== "RESOURCE_EXHAUSTED") return null;
  if (reason !== null && NON_QUOTA_REASONS.has(reason)) return null;
  return {
    reason: (reason ?? "RESOURCE_EXHAUSTED").toLowerCase(),
    resetAt: now + (delayMs ?? DEFAULT_QUOTA_HOLD_MS),
    message,
  };
}

export function geminiWindowsFromQuota(
  payload: unknown,
  now: number,
): LimitWindow[] | null {
  const parsed = retrieveUserQuotaSchema.safeParse(payload);
  if (!parsed.success) return null;
  const slots = new Map<LimitWindowSlot, LimitWindow>();
  for (const bucket of parsed.data.buckets ?? []) {
    if (bucket.remainingFraction == null) continue;
    const slot: LimitWindowSlot = /pro/iu.test(bucket.modelId ?? "")
      ? "primary"
      : "secondary";
    const utilization = Math.max(0, Math.min(1, 1 - bucket.remainingFraction));
    const reset =
      bucket.resetTime == null ? Number.NaN : Date.parse(bucket.resetTime);
    const next: LimitWindow = {
      slot,
      windowMinutes: null,
      utilization,
      resetAt: Number.isNaN(reset) ? null : reset,
      status: utilization >= 1 ? "rejected" : "allowed",
      observedAt: now,
      source: "usage",
    };
    const prior = slots.get(slot);
    if (prior === undefined || (prior.utilization ?? 0) < utilization)
      slots.set(slot, next);
  }
  return (["primary", "secondary"] as const).flatMap((slot) => {
    const window = slots.get(slot);
    return window === undefined ? [] : [window];
  });
}

function googleStatusName(status: number): string {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 499:
      return "CANCELLED";
    case 502:
    case 503:
      return "UNAVAILABLE";
    case 504:
      return "DEADLINE_EXCEEDED";
    default:
      return "INTERNAL";
  }
}

async function refreshGoogleToken(
  doFetch: typeof fetch,
  now: () => number,
  refreshUrl: string,
  refreshToken: string,
  client: GeminiOAuthClient | undefined,
  parentSignal?: AbortSignal,
): Promise<z.infer<typeof refreshResponseSchema>> {
  parentSignal?.throwIfAborted();
  if (client === undefined)
    throw new OAuthRefreshError(
      "Gemini token refresh needs BB_GEMINI_OAUTH_CLIENT_ID and BB_GEMINI_OAUTH_CLIENT_SECRET.",
    );
  const signal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(parentSignal === undefined ? [] : [parentSignal]),
  ]);
  let response: Response;
  try {
    response = await doFetch(refreshUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      signal,
    });
  } catch {
    parentSignal?.throwIfAborted();
    throw new TransientOAuthRefreshError(
      "OAuth refresh failed due to a network error or timeout.",
      0,
    );
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    const message = `OAuth refresh failed with HTTP ${response.status}.`;
    if (response.status === 400 || response.status === 401)
      throw new OAuthRefreshError(message);
    throw new TransientOAuthRefreshError(
      message,
      retryAfterMilliseconds(response.headers.get("retry-after"), now()),
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new TransientOAuthRefreshError(
      "OAuth refresh response failed due to a network error or timeout.",
      0,
    );
  }
  return parseOAuthRefreshResponse(text, refreshResponseSchema);
}

async function codeAssistCall(
  doFetch: typeof fetch,
  baseUrl: string,
  method: string,
  accessToken: string,
  body: unknown,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(parentSignal === undefined ? [] : [parentSignal]),
  ]);
  const response = await doFetch(`${baseUrl}/v1internal:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  signal.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Gemini ${method} failed with HTTP ${response.status}.`);
  }
  return response.json().catch(() => null);
}

const LOAD_CODE_ASSIST_BODY = {
  metadata: {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  },
};

function bodyWithProject(body: Uint8Array, project: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return body;
  const record = parsed as Record<string, unknown>;
  if ("project" in record) record.project = project;
  if ("cloudaicompanionProject" in record)
    record.cloudaicompanionProject = project;
  const metadata = record.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    "duetProject" in metadata
  )
    (metadata as Record<string, unknown>).duetProject = project;
  return new TextEncoder().encode(JSON.stringify(record));
}

function sessionId(body: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const request =
      typeof parsed === "object" && parsed !== null && "request" in parsed
        ? parsed.request
        : null;
    const id =
      typeof request === "object" && request !== null && "session_id" in request
        ? request.session_id
        : null;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

export function createGeminiAdapter(options: {
  refreshUrl: string;
  upstreamBaseUrl: string;
  oauthClient?: GeminiOAuthClient;
  importCredentials?: (home?: string) => Promise<ImportedGeminiCredentials>;
  fetch?: typeof fetch;
  now?: () => number;
}): ProviderAdapter {
  const baseUrl = options.upstreamBaseUrl.replace(/\/+$/u, "");
  const doFetch: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, init);
  const clock = () => (options.now ?? Date.now)();
  const readCredentials = options.importCredentials ?? importGeminiCredentials;
  return {
    provider: "gemini",
    upstreamName: "Google Gemini",
    async localLogin() {
      const imported = await readCredentials().catch(() => null);
      return imported === null
        ? null
        : { email: imported.email, planLabel: null };
    },
    async importAccount(importOptions) {
      const imported = await readCredentials(importOptions?.home);
      let accessToken = imported.accessToken;
      let refreshToken = imported.refreshToken;
      let expiresAt = imported.expiresAt;
      let idToken = imported.idToken;
      if (expiresAt !== null && expiresAt <= clock() + REFRESH_WINDOW_MS) {
        const refreshed = await refreshGoogleToken(
          doFetch,
          clock,
          options.refreshUrl,
          imported.refreshToken,
          options.oauthClient,
        );
        accessToken = refreshed.access_token;
        refreshToken = refreshed.refresh_token ?? refreshToken;
        idToken = refreshed.id_token ?? idToken;
        expiresAt =
          refreshed.expires_in === undefined
            ? null
            : clock() + Math.round(refreshed.expires_in * 1_000);
      }
      const info = parseLoadCodeAssist(
        await codeAssistCall(
          doFetch,
          baseUrl,
          "loadCodeAssist",
          accessToken,
          LOAD_CODE_ASSIST_BODY,
        ),
      );
      if (info === null || info.project === null || info.tier === null) {
        throw new Error(
          "This Google account is not onboarded to Gemini Code Assist (no project or tier). Run `gemini` once with this home to finish onboarding, then retry.",
        );
      }
      return {
        label: imported.email ?? "Gemini account",
        email: imported.email,
        geminiProject: info.project,
        subscriptionType: info.tier,
        rateLimitTier: null,
        secret: {
          kind: "oauth",
          accessToken,
          refreshToken,
          expiresAt,
          ...(idToken === null ? {} : { idToken }),
        },
      };
    },
    parseRequest(body, headers) {
      const rewritable = !headers.has("content-encoding");
      return {
        family: "other",
        affinityId: rewritable ? sessionId(body) : null,
        parentAffinityId: null,
        forAccount: (account) =>
          rewritable && account.geminiProject !== undefined
            ? bodyWithProject(body, account.geminiProject)
            : body,
      };
    },
    upstreamUrl(request) {
      const url = new URL(request.url);
      // Every Code Assist call is `<mount>/v1internal:<method>`; anchor on the
      // API segment so the mount prefix never leaks upstream.
      const api = url.pathname.indexOf("/v1internal");
      const rest = api < 0 ? url.pathname : url.pathname.slice(api);
      return new URL(`${baseUrl}${rest}${url.search}`);
    },
    requestHeaders(inbound, _account, secret) {
      if (secret.kind !== "oauth")
        throw new Error("Gemini accounts require OAuth credentials.");
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        [],
      );
      headers.set("authorization", `Bearer ${secret.accessToken}`);
      return headers;
    },
    quotaFromHeaders(_accountId, _headers, previous) {
      return previous;
    },
    isQuotaRejection() {
      return false;
    },
    quotaRejectionFromBody: geminiQuotaRejection,
    async refreshSecret(context) {
      context.signal?.throwIfAborted();
      const secret = oauthSecretDueForRefresh(context);
      if (secret === null) return { secret: context.secret, refreshed: false };
      const parsed = await refreshGoogleToken(
        context.fetch,
        context.now,
        options.refreshUrl,
        secret.refreshToken,
        options.oauthClient,
        context.signal,
      );
      const refreshed: AccountSecret = {
        kind: "oauth",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? secret.refreshToken,
        ...(parsed.id_token === undefined && secret.idToken === undefined
          ? {}
          : { idToken: parsed.id_token ?? secret.idToken }),
        expiresAt:
          parsed.expires_in === undefined
            ? null
            : context.now() + Math.round(parsed.expires_in * 1_000),
      };
      context.signal?.throwIfAborted();
      await context.accounts.writeSecret(
        context.account.id,
        refreshed,
        context.signal,
      );
      return { secret: refreshed, refreshed: true };
    },
    async refreshUsage(context) {
      context.signal?.throwIfAborted();
      const secret = await context.freshSecret(context.signal);
      context.signal?.throwIfAborted();
      if (secret.kind !== "oauth") return;
      const info = parseLoadCodeAssist(
        await codeAssistCall(
          context.fetch,
          baseUrl,
          "loadCodeAssist",
          secret.accessToken,
          LOAD_CODE_ASSIST_BODY,
          context.signal,
        ),
      );
      if (info === null) throw new Error("Usage refresh returned unreadable data.");
      const project = info.project ?? context.account.geminiProject ?? null;
      if (project === null)
        throw new Error("This Gemini account has no Code Assist project.");
      if (project !== context.account.geminiProject)
        await context.accounts.setGeminiProject(
          context.account.id,
          project,
          context.signal,
        );
      if (info.tier !== null && info.tier !== context.account.subscriptionType)
        await context.accounts.setSubscriptionType(
          context.account.id,
          info.tier,
          context.signal,
        );
      const now = context.now();
      const windows = geminiWindowsFromQuota(
        await codeAssistCall(
          context.fetch,
          baseUrl,
          "retrieveUserQuota",
          secret.accessToken,
          { project },
          context.signal,
        ),
        now,
      );
      if (windows === null)
        throw new Error("Usage refresh returned unreadable data.");
      context.signal?.throwIfAborted();
      const previous = context.quotas.get(context.account.id);
      const rejected = windows.filter((window) => window.status === "rejected");
      const quota: AccountQuota = {
        ...previous,
        accountId: context.account.id,
        limitWindows: windows,
        usageRestriction:
          rejected.length === 0
            ? null
            : (previous.usageRestriction ?? {
                reason: "quota_exhausted",
                resetAt: rejected.reduce<number | null>(
                  (earliest, window) =>
                    window.resetAt === null
                      ? earliest
                      : earliest === null
                        ? window.resetAt
                        : Math.min(earliest, window.resetAt),
                  null,
                ),
              }),
        observedAt: now,
        error: null,
      };
      context.quotas.put(quota);
    },
    errorResponse(status, message, headers) {
      return Response.json(
        {
          error: { code: status, message, status: googleStatusName(status) },
        },
        { status, headers },
      );
    },
  };
}
