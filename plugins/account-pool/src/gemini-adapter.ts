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
  codeAssistModel,
  geminiGatewayCall,
  geminiRuntimeRefusal,
  geminiUpstreamUserAgent,
  modelListResponse,
  unwrapSse,
  unwrapUnary,
} from "./gemini-gateway.js";
import {
  OAuthRefreshError,
  TransientOAuthRefreshError,
  oauthSecretDueForRefresh,
  parseOAuthRefreshResponse,
  type ProviderAdapter,
} from "./provider-adapter.js";
import { retryAfterMilliseconds } from "./quota.js";

// A refresh token is bound to the OAuth client it was issued to. Imported
// accounts carry their own client (from the runtime's token file) in the
// secret; this env fallback (BB_GEMINI_OAUTH_CLIENT_ID and
// BB_GEMINI_OAUTH_CLIENT_SECRET) only serves a secret without one. No client
// secret lives in source.
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
// antigravity-acp 1.5.0 (onboarding module): the first loadCodeAssist goes to
// Prod, then `_determine_endpoint` sends an account whose paidTier has
// usesGcpTos (Enterprise/Workspace) to Prod and every consumer tier (Free,
// Google AI Pro/Ultra) to Prod Daily.
export interface GeminiUpstreamBaseUrls {
  prod: string;
  daily: string;
}
export const DEFAULT_GEMINI_UPSTREAM_BASE_URLS: GeminiUpstreamBaseUrls = {
  prod: "https://cloudcode-pa.googleapis.com",
  daily: "https://daily-cloudcode-pa.googleapis.com",
};
export const DEFAULT_GEMINI_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v3/userinfo";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QUOTA_HOLD_MS = 10 * 60 * 1_000;

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

const tierSchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    usesGcpTos: z.boolean().nullish(),
  })
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

// google.internal.cloud.code.v1internal.QuotaSummaryBucket, as embedded in the
// antigravity-acp 1.5.0 runtime: bucket_id, display_name, description, window,
// remaining_fraction, remaining_amount, disabled, reset_time. It has no model id.
const quotaBucketSchema = z
  .object({
    bucketId: z.string().nullish(),
    displayName: z.string().nullish(),
    remainingFraction: z.number().nullish(),
    disabled: z.boolean().nullish(),
    resetTime: z.string().nullish(),
  })
  .passthrough();

const retrieveUserQuotaSummarySchema = z
  .object({
    buckets: z.array(quotaBucketSchema).nullish(),
    groups: z
      .array(
        z
          .object({ buckets: z.array(quotaBucketSchema).nullish() })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

// The summary also carries buckets for the third-party and image models the
// subscription offers. They never hold the Gemini account.
const NON_GEMINI_BUCKET = /claude|gpt-oss|image/iu;
const PRIMARY_BUCKET = /pro|carbon|argon|hydrogen|orchestrator/iu;

export interface GeminiProjectInfo {
  project: string | null;
  tier: string | null;
  endpoint: "prod" | "daily";
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
    endpoint: parsed.data.paidTier?.usesGcpTos === true ? "prod" : "daily",
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

// Only reasons that name this account's own limit hold it. A reasonless or
// unrecognized RESOURCE_EXHAUSTED may be shared capacity, so it is returned to
// the client instead of putting every account on hold in turn.
const ACCOUNT_QUOTA_REASONS = new Set(["QUOTA_EXHAUSTED", "RATE_LIMIT_EXCEEDED"]);

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
  let status: unknown;
  let reason: string | null = null;
  let delayMs: number | null = null;
  let model: string | null = null;
  try {
    const parsed: unknown = JSON.parse(detail);
    const error =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? parsed.error
        : null;
    if (typeof error === "object" && error !== null) {
      status = "status" in error ? error.status : undefined;
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
        if (
          "metadata" in entry &&
          typeof entry.metadata === "object" &&
          entry.metadata !== null &&
          "model" in entry.metadata &&
          typeof entry.metadata.model === "string"
        )
          model = entry.metadata.model;
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
  if (reason === null || !ACCOUNT_QUOTA_REASONS.has(reason)) return null;
  // A third-party model's quota says nothing about the Gemini models.
  if (model !== null && NON_GEMINI_BUCKET.test(model)) return null;
  return {
    reason: reason.toLowerCase(),
    resetAt: now + (delayMs ?? DEFAULT_QUOTA_HOLD_MS),
    // Google's own error, unchanged: the runtime renders its quota message
    // and reset time from it.
    message: detail,
  };
}

export function geminiWindowsFromQuota(
  payload: unknown,
  now: number,
): LimitWindow[] | null {
  const parsed = retrieveUserQuotaSummarySchema.safeParse(payload);
  if (!parsed.success) return null;
  const slots = new Map<LimitWindowSlot, LimitWindow>();
  // A bucket listed both at the top level and in a group is harmless: each slot
  // keeps the worst bucket, so a repeat changes nothing.
  const buckets = [
    ...(parsed.data.buckets ?? []),
    ...(parsed.data.groups ?? []).flatMap((group) => group.buckets ?? []),
  ];
  for (const bucket of buckets) {
    const name = bucket.bucketId ?? bucket.displayName ?? "";
    if (NON_GEMINI_BUCKET.test(name)) continue;
    if (bucket.disabled === true || bucket.remainingFraction == null) continue;
    const slot: LimitWindowSlot = PRIMARY_BUCKET.test(name)
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
      "This Gemini account has no OAuth client. Remove it and add it again from its Antigravity sign-in.",
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

async function googleEmail(
  doFetch: typeof fetch,
  userinfoUrl: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await doFetch(userinfoUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const parsed = z
      .object({ email: z.string().email() })
      .passthrough()
      .safeParse(await response.json());
    return parsed.success ? parsed.data.email : null;
  } catch {
    return null;
  }
}

// Exactly what antigravity-acp 1.5.0 sends (`_IDE_TYPE = "ANTIGRAVITY"`), so
// Code Assist attributes the call to the Antigravity client.
const LOAD_CODE_ASSIST_BODY = { metadata: { ideType: "ANTIGRAVITY" } };

function genaiBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

export function createGeminiAdapter(options: {
  refreshUrl: string;
  upstreamBaseUrls: GeminiUpstreamBaseUrls;
  userinfoUrl?: string;
  oauthClient?: GeminiOAuthClient;
  importCredentials?: (home?: string) => Promise<ImportedGeminiCredentials>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Sees the model ids each served model list offers. */
  onModels?: (ids: string[]) => void;
}): ProviderAdapter {
  const bases = {
    prod: options.upstreamBaseUrls.prod.replace(/\/+$/u, ""),
    daily: options.upstreamBaseUrls.daily.replace(/\/+$/u, ""),
  };
  // A row without an endpoint yet is sent where the runtime starts: Prod.
  const baseFor = (account: { geminiEndpoint?: "prod" | "daily" }) =>
    bases[account.geminiEndpoint ?? "prod"];
  const doFetch: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, init);
  const clock = () => (options.now ?? Date.now)();
  const readCredentials = options.importCredentials ?? importGeminiCredentials;
  return {
    provider: "gemini",
    upstreamName: "Google Gemini",
    async localLogin() {
      const imported = await readCredentials().catch(() => null);
      return imported === null ? null : { email: null, planLabel: null };
    },
    async importAccount(importOptions) {
      const imported = await readCredentials(importOptions?.home);
      // The runtime's token file holds no access token, so import always
      // refreshes once, with the client the token was issued to.
      const refreshed = await refreshGoogleToken(
        doFetch,
        clock,
        options.refreshUrl,
        imported.refreshToken,
        imported.client,
      );
      const accessToken = refreshed.access_token;
      const refreshToken = refreshed.refresh_token ?? imported.refreshToken;
      const idToken = refreshed.id_token ?? null;
      const expiresAt =
        refreshed.expires_in === undefined
          ? null
          : clock() + Math.round(refreshed.expires_in * 1_000);
      const email = await googleEmail(
        doFetch,
        options.userinfoUrl ?? DEFAULT_GEMINI_USERINFO_URL,
        accessToken,
      );
      const info = parseLoadCodeAssist(
        await codeAssistCall(
          doFetch,
          bases.prod,
          "loadCodeAssist",
          accessToken,
          LOAD_CODE_ASSIST_BODY,
        ),
      );
      const project = info?.project ?? imported.projectId;
      if (info === null || project === null || info.tier === null) {
        throw new Error(
          "This Google account is not onboarded to Gemini Code Assist (no project or tier). Start one chat with bb's Antigravity agent under this GEMINI_HOME to finish onboarding, then retry.",
        );
      }
      return {
        label: email ?? "Gemini account",
        email,
        geminiProject: project,
        geminiEndpoint: info.endpoint,
        subscriptionType: info.tier,
        rateLimitTier: null,
        secret: {
          kind: "oauth",
          accessToken,
          refreshToken,
          expiresAt,
          ...(idToken === null ? {} : { idToken }),
          client: imported.client,
        },
      };
    },
    parseRequest(body, _headers, url) {
      const call = geminiGatewayCall(url);
      if (call?.kind !== "generate") {
        // The model list is the account's own: fetchAvailableModels for its
        // project.
        return {
          family: "other",
          affinityId: null,
          parentAffinityId: null,
          upstreamMethod: "POST",
          forAccount: (account) => encodeJson({ project: account.geminiProject }),
        };
      }
      const genai = genaiBody(body);
      const { model, request } =
        genai === null
          ? { model: call.model, request: null }
          : codeAssistModel(call.model, genai);
      const session = genai?.sessionId;
      return {
        family: "other",
        affinityId: typeof session === "string" && session !== "" ? session : null,
        parentAffinityId: null,
        forAccount: (account) =>
          encodeJson({ model, project: account.geminiProject, request }),
      };
    },
    refuseClient: geminiRuntimeRefusal,
    upstreamUrl(request, _settings, account) {
      const call = geminiGatewayCall(new URL(request.url));
      const method =
        call === null || call.kind === "models"
          ? "fetchAvailableModels"
          : call.method;
      return new URL(
        `${baseFor(account)}/v1internal:${method}${method === "streamGenerateContent" ? "?alt=sse" : ""}`,
      );
    },
    requestHeaders(inbound, _account, secret) {
      if (secret.kind !== "oauth")
        throw new Error("Gemini accounts require OAuth credentials.");
      // Exactly the three headers the runtime's own OAuth client sends.
      return new Headers({
        authorization: `Bearer ${secret.accessToken}`,
        "content-type": "application/json",
        "user-agent": geminiUpstreamUserAgent(inbound),
      });
    },
    transformResponse(response, context) {
      const call = geminiGatewayCall(context.url);
      if (response.body === null) return response;
      const transform =
        call === null || call.kind === "models"
          ? modelListResponse(call?.api ?? "v1beta", (ids) =>
              options.onModels?.(ids),
            )
          : call.method === "generateContent"
            ? unwrapUnary()
            : unwrapSse((detail) => {
                const rejection = geminiQuotaRejection(detail, clock());
                if (rejection !== null) context.onQuotaRejection(rejection);
              });
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      if (call === null || call.kind !== "generate" || call.method === "generateContent")
        headers.set("content-type", "application/json; charset=utf-8");
      return new Response(response.body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
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
        secret.client ?? options.oauthClient,
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
        ...(secret.client === undefined ? {} : { client: secret.client }),
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
          bases.prod,
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
      if (info.endpoint !== context.account.geminiEndpoint)
        await context.accounts.setGeminiEndpoint(
          context.account.id,
          info.endpoint,
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
          bases[info.endpoint],
          "retrieveUserQuotaSummary",
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
      // Google's own error JSON goes back unchanged.
      try {
        const parsed: unknown = JSON.parse(message);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof parsed.error === "object" &&
          parsed.error !== null
        )
          return Response.json(parsed, { status, headers });
      } catch {
        // A plain message is wrapped below.
      }
      return Response.json(
        {
          error: { code: status, message, status: googleStatusName(status) },
        },
        { status, headers },
      );
    },
  };
}
