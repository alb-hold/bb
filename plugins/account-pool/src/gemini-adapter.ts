import { z } from "zod";
import type {
  Account,
  AccountQuota,
  AccountSecret,
  FamilyQuota,
  ImportProbe,
  ImportProbeEndpoint,
  LimitWindow,
} from "./contracts.js";
import {
  importGeminiCredentials,
  importGeminiFileCredentials,
  type ImportedGeminiCredentials,
} from "./gemini-credentials.js";
import {
  advertisedModels,
  codeAssistModel,
  codeAssistModels,
  geminiGatewayCall,
  hasCodeAssistModelList,
  isServedFamily,
  servedFamilyVariant,
  geminiRuntimeRefusal,
  geminiUpstreamUserAgent,
  modelListResponse,
  unwrapSse,
  unwrapUnary,
} from "./gemini-gateway.js";
import {
  OAuthRefreshError,
  oauthRefreshErrorDetail,
  TransientOAuthRefreshError,
  oauthSecretDueForRefresh,
  parseOAuthRefreshResponse,
  type ProviderAdapter,
} from "./provider-adapter.js";
import { retryAfterMilliseconds } from "./quota.js";

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
const USER_AGENT_TTL_MS = 10 * 60 * 1_000;
const GEMINI_USAGE_REFRESH_ERROR_PREFIX = "Gemini usage refresh stopped (";
export const GEMINI_RUNTIME_REFRESH_ERROR_PREFIX = `${GEMINI_USAGE_REFRESH_ERROR_PREFIX}runtime_version): `;
export const GEMINI_QUOTA_READ_ERROR_PREFIX = `${GEMINI_USAGE_REFRESH_ERROR_PREFIX}quota_read): `;

export function isGeminiQuotaReadError(error: string): boolean {
  return error.startsWith(GEMINI_QUOTA_READ_ERROR_PREFIX);
}

export function isGeminiUsageRefreshError(error: string): boolean {
  return error.startsWith(GEMINI_USAGE_REFRESH_ERROR_PREFIX);
}
const DEFAULT_QUOTA_HOLD_MS = 10 * 60 * 1_000;
const SERVED_MODELS_TTL_MS = 10 * 60 * 1_000;

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    id_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

const tierText = z
  .string()
  .nullish()
  .transform((value) => (value == null || value.trim() === "" ? null : value));

const tierSchema = z
  .object({
    id: tierText,
    name: tierText,
    usesGcpTos: z.boolean().nullish(),
    isDefault: z.boolean().nullish(),
  })
  .passthrough()
  .nullish();

const loadCodeAssistSchema = z
  .object({
    cloudaicompanionProject: z
      .union([z.string(), z.object({ id: z.string().nullish() }).passthrough()])
      .nullish(),
    currentTier: tierSchema,
    paidTier: tierSchema,
    allowedTiers: z.array(tierSchema).nullish(),
    ineligibleTiers: z
      .array(
        z
          .object({ tierId: tierText, reasonCode: tierText })
          .passthrough()
          .nullish(),
      )
      .nullish(),
  })
  .passthrough();

const onboardOperationSchema = z
  .object({
    name: z.string().nullish(),
    done: z.boolean().nullish(),
    error: z
      .object({ code: z.number().nullish(), message: z.string().nullish() })
      .passthrough()
      .nullish(),
    response: z
      .object({
        cloudaicompanionProject: z
          .union([
            z.string(),
            z.object({ id: z.string().nullish() }).passthrough(),
          ])
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const quotaBucketSchema = z
  .object({
    bucketId: z.string().nullish(),
    displayName: z.string().nullish(),
    window: z.string().nullish(),
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
          .object({
            displayName: z.string().nullish(),
            buckets: z.array(quotaBucketSchema).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const NON_GEMINI_QUOTA = /claude|gpt|image/iu;
const ROUTED_GEMINI_MODEL = /neon/iu;
const OTHER_GEMINI_MODEL =
  /(?:^|[^a-z])(?:pro|flash|lite|carbon|argon|hydrogen|orchestrator)(?:[^a-z]|$)/iu;
const GEMINI_QUOTA = /gemini/iu;

export type GeminiQuotaWindow = "5h" | "weekly";

const FIVE_HOUR_WINDOW = /5h|5-hour|5 hour|five.?hour/iu;
const WEEKLY_WINDOW = /weekly/iu;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

function quotaWindowOf(bucket: {
  window?: string | null | undefined;
  bucketId?: string | null | undefined;
  displayName?: string | null | undefined;
}): GeminiQuotaWindow | null {
  const raw = (bucket.window ?? "").trim().toLowerCase();
  if (raw === "weekly") return "weekly";
  if (raw === "5h" || raw === "5-hour" || raw === "five_hour") return "5h";
  const text = `${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`;
  if (WEEKLY_WINDOW.test(text)) return "weekly";
  if (FIVE_HOUR_WINDOW.test(text)) return "5h";
  return null;
}

export interface GeminiQuotaBucket {
  group: string | null;
  window: GeminiQuotaWindow | null;
  bucketId: string | null;
  displayName: string | null;
  remainingFraction: number | null;
  resetTime: string | null;
  disabled: boolean;
  slot: "primary" | "skipped";
}

function routesGeminiModel(name: string, group: string | null): boolean {
  if (NON_GEMINI_QUOTA.test(name)) return false;
  if (ROUTED_GEMINI_MODEL.test(name)) return true;
  if (OTHER_GEMINI_MODEL.test(name)) return false;
  if (GEMINI_QUOTA.test(name)) return true;
  return (
    group !== null && GEMINI_QUOTA.test(group) && !NON_GEMINI_QUOTA.test(group)
  );
}

export function geminiQuotaBuckets(
  payload: unknown,
): GeminiQuotaBucket[] | null {
  const parsed = retrieveUserQuotaSummarySchema.safeParse(payload);
  if (!parsed.success) return null;
  return [
    ...(parsed.data.buckets ?? []).map((bucket) => ({ group: null, bucket })),
    ...(parsed.data.groups ?? []).flatMap((group) =>
      (group.buckets ?? []).map((bucket) => ({
        group: group.displayName ?? null,
        bucket,
      })),
    ),
  ].map(({ group, bucket }) => {
    const disabled = bucket.disabled === true;
    const remainingFraction = bucket.remainingFraction ?? null;
    const routed =
      !disabled &&
      remainingFraction !== null &&
      routesGeminiModel(
        `${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`,
        group,
      );
    return {
      group,
      window: quotaWindowOf(bucket),
      bucketId: bucket.bucketId ?? null,
      displayName: bucket.displayName ?? null,
      remainingFraction,
      resetTime: bucket.resetTime ?? null,
      disabled,
      slot: routed ? "primary" : "skipped",
    };
  });
}

export interface GeminiProjectInfo {
  project: string | null;
  tier: string | null;
  endpoint: "prod" | "daily";
}

export function parseLoadCodeAssist(
  payload: unknown,
): GeminiProjectInfo | null {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success) return null;
  const raw = parsed.data.cloudaicompanionProject;
  const project = typeof raw === "string" ? raw : (raw?.id ?? null);
  return {
    project: project === null || project === "" ? null : project,
    tier:
      parsed.data.paidTier?.name ??
      parsed.data.paidTier?.id ??
      parsed.data.currentTier?.name ??
      parsed.data.currentTier?.id ??
      null,
    endpoint: parsed.data.paidTier?.usesGcpTos === true ? "prod" : "daily",
  };
}

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

const ACCOUNT_QUOTA_REASONS = new Set([
  "QUOTA_EXHAUSTED",
  "RATE_LIMIT_EXCEEDED",
]);

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
          delayMs =
            parseGoogleDuration(entry.metadata.quotaResetDelay) ?? delayMs;
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
  if (model !== null && NON_GEMINI_QUOTA.test(model)) return null;
  return {
    reason: reason.toLowerCase(),
    resetAt: now + (delayMs ?? DEFAULT_QUOTA_HOLD_MS),
    message: detail,
  };
}

function quotaWindow(
  bucket: GeminiQuotaBucket,
  remainingFraction: number,
  now: number,
): LimitWindow {
  const utilization = Math.max(0, Math.min(1, 1 - remainingFraction));
  const reset =
    bucket.resetTime === null ? Number.NaN : Date.parse(bucket.resetTime);
  return {
    slot: bucket.window === "weekly" ? "secondary" : "primary",
    windowMinutes:
      bucket.window === "weekly"
        ? WEEKLY_MINUTES
        : bucket.window === "5h"
          ? FIVE_HOUR_MINUTES
          : null,
    utilization,
    resetAt: Number.isNaN(reset) ? null : reset,
    status: utilization >= 1 ? "rejected" : "allowed",
    observedAt: now,
    source: "usage",
  };
}

export function geminiWindowsFromQuota(
  payload: unknown,
  now: number,
): LimitWindow[] {
  const best: Record<"5h" | "weekly" | "other", LimitWindow | null> = {
    "5h": null,
    weekly: null,
    other: null,
  };
  for (const bucket of geminiQuotaBuckets(payload) ?? []) {
    if (bucket.slot === "skipped" || bucket.remainingFraction === null)
      continue;
    const window = quotaWindow(bucket, bucket.remainingFraction, now);
    const key = bucket.window ?? "other";
    const held = best[key];
    if (held === null || (held.utilization ?? 0) < (window.utilization ?? 0))
      best[key] = window;
  }
  if (best["5h"] !== null || best.weekly !== null)
    return [best["5h"], best.weekly].filter(
      (window): window is LimitWindow => window !== null,
    );
  return best.other === null ? [] : [best.other];
}

const THIRD_PARTY_QUOTA = /(?:^|[^a-z0-9])3p(?:[^a-z0-9]|$)|claude|gpt/iu;

export const THIRD_PARTY_QUOTA_LABELS: Record<GeminiQuotaWindow, string> = {
  "5h": "Claude and GPT models · 5 hour",
  weekly: "Claude and GPT models · 7 day",
};

export function geminiThirdPartyDisplay(
  payload: unknown,
  now: number,
): Record<string, FamilyQuota> {
  const best: Partial<Record<GeminiQuotaWindow, FamilyQuota>> = {};
  for (const bucket of geminiQuotaBuckets(payload) ?? []) {
    if (
      bucket.disabled ||
      bucket.window === null ||
      bucket.remainingFraction === null ||
      !THIRD_PARTY_QUOTA.test(
        `${bucket.bucketId ?? ""} ${bucket.displayName ?? ""} ${bucket.group ?? ""}`,
      )
    )
      continue;
    const { utilization, resetAt, status, observedAt, source } = quotaWindow(
      bucket,
      bucket.remainingFraction,
      now,
    );
    const held = best[bucket.window];
    if (held === undefined || (held.utilization ?? 0) < (utilization ?? 0))
      best[bucket.window] = {
        utilization,
        resetAt,
        status,
        observedAt,
        source,
      };
  }
  return Object.fromEntries(
    (["5h", "weekly"] as const).flatMap((window) => {
      const quota = best[window];
      return quota === undefined
        ? []
        : [[THIRD_PARTY_QUOTA_LABELS[window], quota]];
    }),
  );
}

function bucketUse(bucket: { remainingFraction?: number | null | undefined }) {
  return bucket.remainingFraction == null ? -1 : 1 - bucket.remainingFraction;
}

export function mergeQuotaSummaries(payloads: readonly unknown[]): unknown {
  type Bucket = z.infer<typeof quotaBucketSchema>;
  const merged = new Map<string, { group: string | null; bucket: Bucket }>();
  let readable = false;
  for (const payload of payloads) {
    const parsed = retrieveUserQuotaSummarySchema.safeParse(payload);
    if (
      !parsed.success ||
      (!Array.isArray(parsed.data.buckets) &&
        !Array.isArray(parsed.data.groups))
    )
      continue;
    readable = true;
    const entries = [
      ...(parsed.data.buckets ?? []).map((bucket) => ({ group: null, bucket })),
      ...(parsed.data.groups ?? []).flatMap((group) =>
        (group.buckets ?? []).map((bucket) => ({
          group: group.displayName ?? null,
          bucket,
        })),
      ),
    ];
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.group,
        entry.bucket.bucketId ?? entry.bucket.displayName ?? null,
        entry.bucket.window ?? null,
      ]);
      const held = merged.get(key);
      if (
        held === undefined ||
        bucketUse(entry.bucket) > bucketUse(held.bucket)
      )
        merged.set(key, entry);
    }
  }
  if (!readable) return null;
  const groups = new Map<string, Bucket[]>();
  const ungrouped: Bucket[] = [];
  for (const { group, bucket } of merged.values()) {
    if (group === null) ungrouped.push(bucket);
    else groups.set(group, [...(groups.get(group) ?? []), bucket]);
  }
  return {
    buckets: ungrouped,
    groups: [...groups].map(([displayName, buckets]) => ({
      displayName,
      buckets,
    })),
  };
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
    if (response.status === 400 || response.status === 401)
      throw new OAuthRefreshError(
        `OAuth refresh failed with HTTP ${response.status}.${await oauthRefreshErrorDetail(response, new Promise<never>(() => undefined))}`,
      );
    void response.body?.cancel().catch(() => undefined);
    const message = `OAuth refresh failed with HTTP ${response.status}.`;
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
  userAgent: string,
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
      "user-agent": userAgent,
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

const LOAD_CODE_ASSIST_BODY = { metadata: { ideType: "ANTIGRAVITY" } };

function genaiBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

const ONBOARD_POLL_MS = 5_000;
const ONBOARD_TIMEOUT_MS = 120_000;
const OPERATION_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/u;

function tierToOnboard(payload: unknown): string | null {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success) return null;
  const allowed = (parsed.data.allowedTiers ?? []).flatMap((tier) =>
    tier?.id == null ? [] : [tier],
  );
  const fallbacks = [parsed.data.paidTier?.id, parsed.data.currentTier?.id];
  if (parsed.data.allowedTiers == null)
    return fallbacks.find((id) => id != null) ?? null;
  const allowedIds = new Set(allowed.map((tier) => tier.id));
  return (
    allowed.find((tier) => tier.isDefault === true)?.id ??
    fallbacks.find((id) => id != null && allowedIds.has(id)) ??
    null
  );
}

function offeredTierIds(payload: unknown): string {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success) return "current=none, paid=none, allowed=none";
  const current = parsed.data.currentTier?.id ?? "none";
  const paid = parsed.data.paidTier?.id ?? "none";
  const allowed =
    (parsed.data.allowedTiers ?? [])
      .flatMap((tier) =>
        tier?.id == null
          ? []
          : [tier.isDefault === true ? `${tier.id}(default)` : tier.id],
      )
      .join(",") || "none";
  return `current=${current}, paid=${paid}, allowed=${allowed}`;
}

type LoadOutcome =
  | { kind: "answered"; payload: unknown; info: GeminiProjectInfo }
  | { kind: "unreadable" }
  | { kind: "failed"; error: unknown };

type GeminiSources =
  | { daily: LoadOutcome & { kind: "answered" }; prod: null }
  | { daily: LoadOutcome; prod: LoadOutcome };

type GeminiImportPlan =
  | {
      kind: "project";
      loadedFrom: "daily" | "prod";
      project: string;
      info: GeminiProjectInfo & { tier: string };
    }
  | {
      kind: "onboard";
      endpoint: "daily" | "prod";
      tierId: string;
      tierIds: string;
      dailyTierIds: string;
      project: string | null;
      loadedInfo: GeminiProjectInfo;
    }
  | { kind: "refuse"; error: Error };

async function loadOutcome(call: () => Promise<unknown>): Promise<LoadOutcome> {
  try {
    const payload = await call();
    const info = parseLoadCodeAssist(payload);
    return info === null
      ? { kind: "unreadable" }
      : { kind: "answered", payload, info };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeTierIds(outcome: LoadOutcome): string {
  if (outcome.kind === "answered") return offeredTierIds(outcome.payload);
  if (outcome.kind === "unreadable") return "unreadable loadCodeAssist answer";
  return `loadCodeAssist failed: ${errorMessage(outcome.error)}`;
}

function hasProjectAndTier(
  outcome: LoadOutcome,
): outcome is LoadOutcome & { kind: "answered" } {
  return (
    outcome.kind === "answered" &&
    outcome.info.project !== null &&
    outcome.info.tier !== null
  );
}

function projectPlan(
  outcome: LoadOutcome,
  loadedFrom: "daily" | "prod",
): GeminiImportPlan | null {
  if (outcome.kind !== "answered") return null;
  const { project, tier } = outcome.info;
  if (project === null || tier === null) return null;
  return {
    kind: "project",
    loadedFrom,
    project,
    info: { ...outcome.info, tier },
  };
}

function planGeminiImport(
  sources: GeminiSources,
  importedProject: string | null,
): GeminiImportPlan {
  const { daily, prod } = sources;
  if (prod === null)
    return (
      projectPlan(daily, "daily") ?? {
        kind: "refuse",
        error: new Error("Gemini Code Assist daily answer lost its project."),
      }
    );
  const chosen = projectPlan(prod, "prod") ?? projectPlan(daily, "daily");
  if (chosen !== null) return chosen;
  const dailyTierIds = outcomeTierIds(daily);
  if (prod.kind === "failed")
    return {
      kind: "refuse",
      error: new Error(
        `${errorMessage(prod.error)} (stage: loadCodeAssist prod; tier ids: daily [${dailyTierIds}])`,
        { cause: prod.error },
      ),
    };
  if (prod.kind === "unreadable")
    return {
      kind: "refuse",
      error: new Error(
        `Gemini Code Assist sent an unreadable answer for this account (stage: loadCodeAssist; tier ids: daily [${dailyTierIds}]).`,
      ),
    };
  const tierIds = `prod [${offeredTierIds(prod.payload)}]; daily [${dailyTierIds}]`;
  const project = prod.info.project ?? importedProject;
  if (project !== null && prod.info.tier !== null)
    return {
      kind: "project",
      loadedFrom: "prod",
      project,
      info: { ...prod.info, tier: prod.info.tier },
    };
  const tierId = tierToOnboard(prod.payload);
  if (tierId === null)
    return {
      kind: "refuse",
      error: new Error(
        `Gemini Code Assist has no ${missingFields(project, prod.info.tier)} for this account and offered no tier to onboard it to (stage: loadCodeAssist; tier ids: ${tierIds}).`,
      ),
    };
  const cloudProject =
    tierId === "standard-tier" && project === null
      ? process.env.GOOGLE_CLOUD_PROJECT?.trim() || null
      : project;
  const dailyTier =
    tierId === "standard-tier" &&
    cloudProject === null &&
    daily.kind === "answered" &&
    daily.info.project === null
      ? defaultAllowedTier(daily.payload)
      : null;
  if (daily.kind === "answered" && dailyTier !== null)
    return {
      kind: "onboard",
      endpoint: "daily",
      tierId: dailyTier,
      tierIds: `daily [${dailyTierIds}]; prod [${offeredTierIds(prod.payload)}]`,
      dailyTierIds,
      project: null,
      loadedInfo: daily.info,
    };
  return {
    kind: "onboard",
    endpoint: "prod",
    tierId,
    tierIds,
    dailyTierIds,
    project: cloudProject,
    loadedInfo: prod.info,
  };
}

function defaultAllowedTier(payload: unknown): string | null {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success) return null;
  return (
    (parsed.data.allowedTiers ?? []).find(
      (tier) => tier?.isDefault === true && tier.id != null,
    )?.id ?? null
  );
}

function probeTiers(payload: unknown): {
  currentTier: string | null;
  paidTier: string | null;
  allowedTiers: Array<{ id: string; isDefault: boolean }>;
  ineligibleTiers: Array<{ id: string | null; reasonCode: string | null }>;
} {
  const parsed = loadCodeAssistSchema.safeParse(payload);
  if (!parsed.success)
    return {
      currentTier: null,
      paidTier: null,
      allowedTiers: [],
      ineligibleTiers: [],
    };
  return {
    currentTier: parsed.data.currentTier?.id ?? null,
    paidTier: parsed.data.paidTier?.id ?? null,
    allowedTiers: (parsed.data.allowedTiers ?? []).flatMap((tier) =>
      tier?.id == null
        ? []
        : [{ id: tier.id, isDefault: tier.isDefault === true }],
    ),
    ineligibleTiers: (parsed.data.ineligibleTiers ?? []).flatMap((tier) =>
      tier == null ? [] : [{ id: tier.tierId, reasonCode: tier.reasonCode }],
    ),
  };
}

function probeEndpoint(
  endpoint: "daily" | "prod",
  outcome: LoadOutcome | null,
): ImportProbeEndpoint {
  if (outcome?.kind !== "answered")
    return {
      endpoint,
      status: outcome === null ? "not-loaded" : outcome.kind,
      currentTier: null,
      paidTier: null,
      allowedTiers: [],
      ineligibleTiers: [],
      projectPresent: false,
    };
  return {
    endpoint,
    status: "answered",
    ...probeTiers(outcome.payload),
    projectPresent: outcome.info.project !== null,
  };
}

export function clientIdSuffix(clientId: string): string {
  return clientId.replace(/\.apps\.googleusercontent\.com$/u, "").slice(-6);
}

function missingFields(project: string | null, tier: string | null): string {
  return [project === null ? "project" : null, tier === null ? "tier" : null]
    .filter((field) => field !== null)
    .join(" and ");
}

function operationProject(
  raw: string | { id?: string | null | undefined } | null | undefined,
): string | null {
  const id = typeof raw === "string" ? raw : (raw?.id ?? null);
  return id === null || id === "" ? null : id;
}

async function getCodeAssistOperation(
  doFetch: typeof fetch,
  baseUrl: string,
  name: string,
  accessToken: string,
  tierIds: string,
  userAgent: string,
): Promise<unknown> {
  if (!OPERATION_NAME.test(name) || name.split("/").includes(".."))
    throw new Error(
      `Gemini Code Assist onboarding returned an operation name bb does not accept (stage: onboardUser operation; tier ids: ${tierIds}).`,
    );
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await doFetch(`${baseUrl}/v1internal/${name}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": userAgent,
    },
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Gemini Code Assist onboarding status check failed with HTTP ${response.status} (stage: onboardUser operation; tier ids: ${tierIds}).`,
    );
  }
  return response.json().catch(() => null);
}

function onboardingFields(payload: unknown, prefix = "", depth = 0): string[] {
  if (
    depth > 2 ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    return [];
  return Object.entries(payload)
    .slice(0, 16)
    .flatMap(([key, value]) => {
      if (!/^@?[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) return [];
      const path = prefix + key;
      return [path, ...onboardingFields(value, path + ".", depth + 1)];
    });
}

async function onboardCodeAssist(args: {
  doFetch: typeof fetch;
  baseUrl: string;
  accessToken: string;
  tierId: string;
  tierIds: string;
  project: string | null;
  userAgent: string;
  pollMs: number;
  timeoutMs: number;
}): Promise<string | null> {
  const body = {
    tierId: args.tierId,
    ...(args.tierId === "free-tier" || args.project === null
      ? {}
      : { cloudaicompanionProject: args.project }),
    metadata: LOAD_CODE_ASSIST_BODY.metadata,
  };
  const readOperation = (payload: unknown) => {
    const parsed = onboardOperationSchema.safeParse(payload);
    if (!parsed.success)
      throw new Error(
        `Gemini Code Assist sent an unreadable onboarding answer (stage: onboardUser; fields: ${onboardingFields(payload).join(", ").slice(0, 1024) || "none"}; tier ids: ${args.tierIds}).`,
      );
    return parsed.data;
  };
  const onboard = async () => {
    try {
      return await codeAssistCall(
        args.doFetch,
        args.baseUrl,
        "onboardUser",
        args.accessToken,
        body,
        args.userAgent,
      );
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${original} (stage: onboardUser; tier id: ${args.tierId}; tier ids: ${args.tierIds})`,
        { cause: error },
      );
    }
  };
  let operation = readOperation(await onboard());
  let name = operation.name;
  const deadline = Date.now() + args.timeoutMs;
  while (operation.done !== true) {
    if (Date.now() >= deadline)
      throw new Error(
        `Gemini Code Assist onboarding was still pending after ${Math.round(args.timeoutMs / 1_000)}s (stage: onboardUser operation; tier id: ${args.tierId}; tier ids: ${args.tierIds}). Retry in a few minutes.`,
      );
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
    operation = readOperation(
      name
        ? await getCodeAssistOperation(
            args.doFetch,
            args.baseUrl,
            name,
            args.accessToken,
            args.tierIds,
            args.userAgent,
          )
        : await onboard(),
    );
    name = operation.name || name;
  }
  if (operation.error != null)
    throw new Error(
      `Gemini Code Assist refused to onboard this account (stage: onboardUser; tier id: ${args.tierId}; code: ${operation.error.code ?? "unknown"}; tier ids: ${args.tierIds}).`,
    );
  return operationProject(operation.response?.cloudaicompanionProject);
}

export function createGeminiAdapter(options: {
  refreshUrl: string;
  upstreamBaseUrls: GeminiUpstreamBaseUrls;
  userinfoUrl?: string;
  oauthClient?: GeminiOAuthClient;
  importCredentials?: (home?: string) => Promise<ImportedGeminiCredentials>;
  fetch?: typeof fetch;
  now?: () => number;
  onModels?: (accountId: string, ids: string[], servedIds: string[]) => void;
  savedModels?: () => Readonly<
    Record<
      string,
      | readonly string[]
      | { served: readonly string[]; aliases: readonly string[] }
    >
  >;
  onboarding?: { pollMs: number; timeoutMs: number };
  runtimeUserAgent: () => Promise<string>;
}): ProviderAdapter {
  let cachedAgent: { value: string; at: number } | null = null;
  let readingAgent: Promise<string> | null = null;
  const userAgent = async () => {
    const at = (options.now ?? Date.now)();
    if (cachedAgent !== null && at - cachedAgent.at < USER_AGENT_TTL_MS)
      return cachedAgent.value;
    readingAgent ??= options.runtimeUserAgent().finally(() => {
      readingAgent = null;
    });
    try {
      const value = await readingAgent;
      cachedAgent = { value, at };
      return value;
    } catch (error) {
      if (cachedAgent === null) throw error;
      cachedAgent = { value: cachedAgent.value, at };
      return cachedAgent.value;
    }
  };
  const bases = {
    prod: options.upstreamBaseUrls.prod.replace(/\/+$/u, ""),
    daily: options.upstreamBaseUrls.daily.replace(/\/+$/u, ""),
  };
  const baseFor = (account: { geminiEndpoint?: "prod" | "daily" }) =>
    bases[account.geminiEndpoint ?? "prod"];
  const doFetch: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, init);
  const clock = () => (options.now ?? Date.now)();
  const servedModels = new Map<
    string,
    { ids: ReadonlySet<string>; at: number }
  >();
  const servedRefreshes = new Map<string, Promise<void>>();
  const rememberServed = (
    accountId: string,
    served: string[],
    advertised: string[],
  ) => {
    servedModels.set(accountId, { ids: new Set(served), at: clock() });
    options.onModels?.(accountId, advertised, served);
  };
  const isKnownFamily = (model: string) =>
    [...servedModels.values()].some((entry) =>
      isServedFamily(model, entry.ids),
    ) ||
    isServedFamily(
      model,
      new Set(
        Object.entries(options.savedModels?.() ?? {}).flatMap(
          ([accountId, entry]) =>
            servedModels.has(accountId)
              ? []
              : "served" in entry
                ? [...entry.served, ...entry.aliases]
                : entry,
        ),
      ),
    );
  const savedServed = (accountId: string): ReadonlySet<string> | undefined => {
    const saved = options.savedModels?.()[accountId];
    if (saved === undefined) return undefined;
    if ("served" in saved) return new Set(saved.served);
    return new Set(saved);
  };
  const refreshServed = (
    account: Account,
    secret: AccountSecret,
    signal: AbortSignal,
  ): Promise<void> => {
    const running = servedRefreshes.get(account.id);
    if (running !== undefined) return running;
    const flight = (async () => {
      if (secret.kind !== "oauth") return;
      const payload = await codeAssistCall(
        doFetch,
        baseFor(account),
        "fetchAvailableModels",
        secret.accessToken,
        { project: account.geminiProject },
        await userAgent(),
        signal,
      );
      if (!hasCodeAssistModelList(payload)) return;
      const served = codeAssistModels(payload);
      rememberServed(
        account.id,
        served.map((model) => model.id),
        advertisedModels(served).map((model) => model.id),
      );
    })()
      .catch(() => undefined)
      .finally(() => {
        servedRefreshes.delete(account.id);
      });
    servedRefreshes.set(account.id, flight);
    return flight;
  };
  const readCredentials = options.importCredentials ?? importGeminiCredentials;
  const signIn = async (importOptions?: { home?: string }) => {
    const imported = await readCredentials(importOptions?.home);
    const refreshed = await refreshGoogleToken(
      doFetch,
      clock,
      options.refreshUrl,
      imported.refreshToken,
      imported.client,
    ).catch((error: unknown) => {
      if (
        imported.clientSource === "antigravity-installed-app" &&
        error instanceof OAuthRefreshError
      )
        throw new Error(
          `The Antigravity sign-in has no OAuth client of its own, and Google did not renew it with Antigravity's installed-app client (${error.message}) Sign in through bb's Antigravity (antigravity-acp) agent, then retry.`,
        );
      throw error;
    });
    return {
      imported,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? imported.refreshToken,
      idToken: refreshed.id_token ?? null,
      expiresAt:
        refreshed.expires_in === undefined
          ? null
          : clock() + Math.round(refreshed.expires_in * 1_000),
    };
  };
  const loadOn = async (endpoint: "prod" | "daily", accessToken: string) =>
    codeAssistCall(
      doFetch,
      bases[endpoint],
      "loadCodeAssist",
      accessToken,
      LOAD_CODE_ASSIST_BODY,
      await userAgent(),
    );
  const loadSources = async (accessToken: string): Promise<GeminiSources> => {
    await userAgent();
    const daily = await loadOutcome(() => loadOn("daily", accessToken));
    if (hasProjectAndTier(daily) && daily.info.endpoint === "daily")
      return { daily, prod: null };
    return {
      daily,
      prod: await loadOutcome(() => loadOn("prod", accessToken)),
    };
  };
  return {
    provider: "gemini",
    upstreamName: "Google Gemini",
    usageFromResponses: false,
    async localLogin() {
      const imported = await importGeminiFileCredentials().catch(() => null);
      return imported === null ? null : { email: null, planLabel: null };
    },
    async importAccount(importOptions) {
      const signedIn = await signIn(importOptions);
      const { imported, accessToken, refreshToken, idToken, expiresAt } =
        signedIn;
      const email = await googleEmail(
        doFetch,
        options.userinfoUrl ?? DEFAULT_GEMINI_USERINFO_URL,
        accessToken,
      );
      if (email === null) {
        throw new Error(
          "bb could not read this Google account's email, so it cannot tell whether the account is already in the pool. Check the connection and retry.",
        );
      }
      const accountWithProject = (
        resolvedProject: string,
        resolvedInfo: GeminiProjectInfo & { tier: string },
      ) => ({
        label: email,
        email,
        geminiProject: resolvedProject,
        geminiEndpoint: resolvedInfo.endpoint,
        subscriptionType: resolvedInfo.tier,
        rateLimitTier: null,
        secret: {
          kind: "oauth" as const,
          accessToken,
          refreshToken,
          expiresAt,
          ...(idToken === null ? {} : { idToken }),
          client: imported.client,
        },
      });
      const plan = planGeminiImport(
        await loadSources(accessToken),
        imported.projectId,
      );
      if (plan.kind === "refuse") throw plan.error;
      if (plan.kind === "project")
        return accountWithProject(plan.project, plan.info);
      const onboarded = await onboardCodeAssist({
        doFetch,
        baseUrl: bases[plan.endpoint],
        accessToken,
        tierId: plan.tierId,
        tierIds: plan.tierIds,
        project: plan.project,
        userAgent: await userAgent(),
        pollMs: options.onboarding?.pollMs ?? ONBOARD_POLL_MS,
        timeoutMs: options.onboarding?.timeoutMs ?? ONBOARD_TIMEOUT_MS,
      });
      const loaded = await loadOn(plan.endpoint, accessToken);
      const info = parseLoadCodeAssist(loaded) ?? plan.loadedInfo;
      const project = info.project ?? onboarded ?? plan.project;
      const tierIds =
        plan.endpoint === "daily"
          ? `daily [${offeredTierIds(loaded)}]`
          : `prod [${offeredTierIds(loaded)}]; daily [${plan.dailyTierIds}]`;
      if (project === null && plan.endpoint === "daily")
        throw new Error(
          `Gemini Code Assist onboarded ${plan.tierId} on the Antigravity daily endpoint but returned no Google-managed project (stage: loadCodeAssist after onboardUser; tier ids: ${tierIds}).`,
        );
      if (project === null && plan.tierId === "standard-tier")
        throw new Error(
          `Gemini Code Assist returned no project for standard-tier onboarding. Set GOOGLE_CLOUD_PROJECT to your Google Cloud project ID and retry the import. (tier ids: ${tierIds})`,
        );
      if (project === null || info.tier === null)
        throw new Error(
          `Gemini Code Assist still has no ${missingFields(project, info.tier)} for this account after onboarding (stage: loadCodeAssist after onboardUser; tier ids: ${tierIds}).`,
        );
      return accountWithProject(project, { ...info, tier: info.tier });
    },
    async probeImport(importOptions) {
      const { imported, accessToken, expiresAt } = await signIn(importOptions);
      const credential: ImportProbe["credential"] = {
        source: imported.source.kind,
        clientIdSuffix: clientIdSuffix(imported.client.clientId),
        clientSource: imported.clientSource ?? "own",
        storedExpiresAt: imported.storedExpiresAt,
        accessTokenExpiresAt: expiresAt,
      };
      const sources = await loadSources(accessToken);
      const plan = planGeminiImport(sources, imported.projectId);
      let quota: ImportProbe["quota"] = { kind: "not-checked" };
      if (plan.kind === "project") {
        try {
          const summary = await codeAssistCall(
            doFetch,
            bases.daily,
            "retrieveUserQuotaSummary",
            accessToken,
            { project: plan.project },
            await userAgent(),
          );
          quota = {
            kind: "answered",
            windows: geminiWindowsFromQuota(summary, clock()).length,
            buckets: geminiQuotaBuckets(summary) ?? [],
          };
        } catch {
          quota = { kind: "failed" };
        }
      }
      return {
        provider: "gemini",
        credential,
        userAgent: await userAgent(),
        endpoints: [
          probeEndpoint("daily", sources.daily),
          probeEndpoint("prod", sources.prod),
        ],
        wouldUse:
          plan.kind === "project"
            ? {
                kind: "project",
                loadedFrom: plan.loadedFrom,
                servesOn: plan.info.endpoint,
              }
            : plan.kind === "onboard"
              ? {
                  kind: "onboard",
                  endpoint: plan.endpoint,
                  tierId: plan.tierId,
                }
              : { kind: "none" },
        quota,
      };
    },
    parseRequest(body, _headers, url) {
      const call = geminiGatewayCall(url);
      if (call?.kind !== "generate") {
        return {
          family: "other",
          affinityId: null,
          parentAffinityId: null,
          upstreamMethod: "POST",
          unmetered: call?.kind === "models",
          forAccount: (account) =>
            encodeJson({ project: account.geminiProject }),
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
        affinityId:
          typeof session === "string" && session !== "" ? session : null,
        parentAffinityId: null,
        async prepare(account, secret, signal) {
          if (!isKnownFamily(model)) return;
          const cached = servedModels.get(account.id);
          if (
            cached !== undefined &&
            clock() - cached.at < SERVED_MODELS_TTL_MS
          )
            return;
          await refreshServed(account, secret, signal);
        },
        forAccount: (account) => {
          const served =
            servedModels.get(account.id)?.ids ?? savedServed(account.id);
          return encodeJson({
            model:
              served === undefined
                ? model
                : (servedFamilyVariant(model, served) ?? model),
            project: account.geminiProject,
            request,
          });
        },
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
          ? modelListResponse(call?.api ?? "v1beta", (served, advertised) =>
              rememberServed(context.account.id, served, advertised),
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
      if (
        call === null ||
        call.kind !== "generate" ||
        call.method === "generateContent"
      )
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
    isTransientUsageError: isGeminiUsageRefreshError,
    isNonBlockingUsageError: isGeminiQuotaReadError,
    async refreshUsage(context) {
      context.signal?.throwIfAborted();
      const agent = await userAgent().catch((error: unknown) => {
        const previous = context.quotas.get(context.account.id);
        if (
          previous.error === null ||
          isGeminiUsageRefreshError(previous.error)
        )
          context.quotas.put({
            ...previous,
            error: `${GEMINI_RUNTIME_REFRESH_ERROR_PREFIX}${errorMessage(error)}`,
          });
        throw error;
      });
      const stale = context.quotas.get(context.account.id);
      if (stale.error !== null && isGeminiUsageRefreshError(stale.error))
        context.quotas.put({ ...stale, error: null });
      const secret = await context.freshSecret(context.signal);
      try {
        context.signal?.throwIfAborted();
        if (secret.kind !== "oauth")
          throw new Error("Gemini usage refresh requires OAuth credentials.");
        const info = parseLoadCodeAssist(
          await codeAssistCall(
            context.fetch,
            baseFor(context.account),
            "loadCodeAssist",
            secret.accessToken,
            LOAD_CODE_ASSIST_BODY,
            agent,
            context.signal,
          ),
        );
        if (info === null)
          throw new Error("Usage refresh returned unreadable data.");
        const stored = context.account.geminiProject ?? null;
        let otherCompanion: Promise<string | null> | undefined;
        const loadOtherCompanion = () =>
          (otherCompanion ??= codeAssistCall(
            context.fetch,
            baseFor(context.account) === bases.daily ? bases.prod : bases.daily,
            "loadCodeAssist",
            secret.accessToken,
            LOAD_CODE_ASSIST_BODY,
            agent,
            context.signal,
          )
            .then((payload) => parseLoadCodeAssist(payload)?.project ?? null)
            .catch(() => null));
        const candidateSources: Array<() => Promise<string | null>> = [
          async () => info.project,
          loadOtherCompanion,
          async () => stored,
        ];
        if (info.endpoint !== context.account.geminiEndpoint)
          await context.accounts.setGeminiEndpoint(
            context.account.id,
            info.endpoint,
            context.signal,
          );
        if (
          info.tier !== null &&
          info.tier !== context.account.subscriptionType
        )
          await context.accounts.setSubscriptionType(
            context.account.id,
            info.tier,
            context.signal,
          );
        let quotaSummary: unknown = null;
        let quotaFailure: unknown = null;
        let quotaFailed = false;
        let quotaProject: string | null = null;
        let thirdPartySummary: unknown = null;
        let found = false;
        const tried = new Set<string | null>();
        const sources = [...candidateSources, async () => null];
        for (const [index, source] of sources.entries()) {
          const candidate = await source();
          context.signal?.throwIfAborted();
          if (tried.has(candidate)) continue;
          if (candidate === null && index < sources.length - 1) continue;
          tried.add(candidate);
          const settled = await Promise.allSettled(
            [...new Set([bases.daily, bases.prod])].map((base) =>
              codeAssistCall(
                context.fetch,
                base,
                "retrieveUserQuotaSummary",
                secret.accessToken,
                candidate === null ? {} : { project: candidate },
                agent,
                context.signal,
              ),
            ),
          );
          context.signal?.throwIfAborted();
          const rejection = settled.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          const answers = settled.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          if (rejection !== undefined) {
            quotaFailed = true;
            quotaFailure ??= rejection.reason;
          }
          if (answers.some((answer) => mergeQuotaSummaries([answer]) === null))
            quotaFailed = true;
          const merged = mergeQuotaSummaries(answers);
          if (merged === null) continue;
          if (geminiWindowsFromQuota(merged, context.now()).length > 0) {
            quotaSummary = merged;
            quotaProject = candidate;
            found = true;
            break;
          }
          if (
            thirdPartySummary === null &&
            Object.keys(geminiThirdPartyDisplay(merged, context.now())).length >
              0
          )
            thirdPartySummary = merged;
          if (
            quotaSummary === null ||
            !geminiQuotaBuckets(quotaSummary)?.length
          )
            quotaSummary = merged;
        }
        if (!found && quotaFailed)
          throw (
            quotaFailure ?? new Error("Usage refresh returned unreadable data.")
          );
        if (quotaSummary === null) {
          throw new Error("Usage refresh returned unreadable data.");
        }
        const now = context.now();
        const bucketCount = geminiQuotaBuckets(quotaSummary)?.length ?? 0;
        const keepStored = !found && thirdPartySummary !== null;
        const windows = keepStored
          ? context.quotas.get(context.account.id).limitWindows
          : geminiWindowsFromQuota(quotaSummary, now);
        if (!keepStored && bucketCount > 0 && windows.length === 0)
          throw new Error(
            "Usage refresh returned no recognized quota buckets.",
          );
        const winnerDisplay = found
          ? geminiThirdPartyDisplay(quotaSummary, now)
          : {};
        const thirdParty =
          Object.keys(winnerDisplay).length > 0 || thirdPartySummary === null
            ? winnerDisplay
            : geminiThirdPartyDisplay(thirdPartySummary, now);
        const previous = context.quotas.get(context.account.id);
        const rejected = windows.filter(
          (window) => window.status === "rejected",
        );
        const quota: AccountQuota = {
          ...previous,
          accountId: context.account.id,
          limitWindows: windows,
          usageRestriction:
            keepStored || windows.length === 0
              ? previous.usageRestriction
              : rejected.length === 0
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
          observedAt: keepStored ? previous.observedAt : now,
          error: null,
        };
        context.signal?.throwIfAborted();
        context.quotas.putModelWeekly(context.account.id, thirdParty);
        context.quotas.put(quota);
        if (
          found &&
          quotaProject !== null &&
          quotaProject !== context.account.geminiProject
        )
          await context.accounts.setGeminiProject(
            context.account.id,
            quotaProject,
          );
      } catch (error) {
        if (context.signal?.aborted !== true)
          context.quotas.put({
            ...context.quotas.get(context.account.id),
            error:
              `${GEMINI_QUOTA_READ_ERROR_PREFIX}${errorMessage(error)}`.slice(
                0,
                1_000,
              ),
          });
        throw error;
      }
    },
    errorResponse(status, message, headers) {
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
      } catch {}
      return Response.json(
        {
          error: { code: status, message, status: googleStatusName(status) },
        },
        { status, headers },
      );
    },
  };
}
