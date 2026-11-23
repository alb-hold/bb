import { z } from "zod";
import type {
  AccountQuota,
  AccountSecret,
  ImportProbe,
  ImportProbeEndpoint,
  LimitWindow,
  LimitWindowSlot,
} from "./contracts.js";
import {
  importGeminiCredentials,
  importGeminiFileCredentials,
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
const DEFAULT_QUOTA_HOLD_MS = 10 * 60 * 1_000;

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
          .union([z.string(), z.object({ id: z.string().nullish() }).passthrough()])
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

const NON_GEMINI_BUCKET = /claude|gpt-oss|image/iu;
const PRIMARY_BUCKET = /pro|carbon|argon|hydrogen|neon|orchestrator/iu;

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

const ACCOUNT_QUOTA_REASONS = new Set(["QUOTA_EXHAUSTED", "RATE_LIMIT_EXCEEDED"]);

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
  if (model !== null && NON_GEMINI_BUCKET.test(model)) return null;
  return {
    reason: reason.toLowerCase(),
    resetAt: now + (delayMs ?? DEFAULT_QUOTA_HOLD_MS),
    message: detail,
  };
}

export function geminiWindowsFromQuota(
  payload: unknown,
  now: number,
): LimitWindow[] {
  const parsed = retrieveUserQuotaSummarySchema.safeParse(payload);
  if (!parsed.success) return [];
  const slots = new Map<LimitWindowSlot, LimitWindow>();
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
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
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
  const allowed = (parsed.data.allowedTiers ?? [])
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
  return { kind: "project", loadedFrom, project, info: { ...outcome.info, tier } };
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
    return { currentTier: null, paidTier: null, allowedTiers: [], ineligibleTiers: [] };
  return {
    currentTier: parsed.data.currentTier?.id ?? null,
    paidTier: parsed.data.paidTier?.id ?? null,
    allowedTiers: (parsed.data.allowedTiers ?? []).flatMap((tier) =>
      tier?.id == null ? [] : [{ id: tier.id, isDefault: tier.isDefault === true }],
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
  if (depth > 2 || payload === null || typeof payload !== "object" || Array.isArray(payload))
    return [];
  return Object.entries(payload).slice(0, 16).flatMap(([key, value]) => {
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
        ? await getCodeAssistOperation(args.doFetch, args.baseUrl, name, args.accessToken, args.tierIds, args.userAgent)
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
  onModels?: (accountId: string, ids: string[]) => void;
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
    async localLogin() {
      const imported = await importGeminiFileCredentials().catch(() => null);
      return imported === null ? null : { email: null, planLabel: null };
    },
    async importAccount(importOptions) {
      const signedIn = await signIn(importOptions);
      const { imported, accessToken, refreshToken, idToken, expiresAt } = signedIn;
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
        source: imported.source,
        email: await googleEmail(
          doFetch,
          options.userinfoUrl ?? DEFAULT_GEMINI_USERINFO_URL,
          accessToken,
        ),
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
          const windows = geminiWindowsFromQuota(
            await codeAssistCall(
              doFetch,
              bases.daily,
              "retrieveUserQuotaSummary",
              accessToken,
              { project: plan.project },
              await userAgent(),
            ),
            clock(),
          );
          quota = { kind: "answered", windows: windows.length };
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
              ? { kind: "onboard", endpoint: plan.endpoint, tierId: plan.tierId }
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
              options.onModels?.(context.account.id, ids),
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
      const agent = await userAgent().catch((error: unknown) => {
        context.quotas.put({
          ...context.quotas.get(context.account.id),
          error: `Gemini usage refresh stopped (runtime_version): ${errorMessage(error)}`,
        });
        throw error;
      });
      const secret = await context.freshSecret(context.signal);
      context.signal?.throwIfAborted();
      if (secret.kind !== "oauth") return;
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
          bases.daily,
          "retrieveUserQuotaSummary",
          secret.accessToken,
          { project },
          agent,
          context.signal,
        ),
        now,
      );
      context.signal?.throwIfAborted();
      const previous = context.quotas.get(context.account.id);
      const rejected = windows.filter((window) => window.status === "rejected");
      const quota: AccountQuota = {
        ...previous,
        accountId: context.account.id,
        limitWindows: windows,
        usageRestriction:
          windows.length === 0
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
        observedAt: now,
        error: null,
      };
      context.quotas.put(quota);
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
      } catch {
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
