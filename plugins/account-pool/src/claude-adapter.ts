import { z } from "zod";
import {
  type ClaudeProfile,
  claudePlanFromProfile,
  claudeProfileSchema,
} from "./claude-profile.js";
import type { AccountSecret } from "./contracts.js";
import {
  importClaudeCredentials,
  type ImportedClaudeCredentials,
} from "./credentials.js";
import type {
  ProviderAdapter,
  AdapterUsageContext,
} from "./provider-adapter.js";
import {
  fetchOAuthRefresh,
  filterRequestHeaders,
  mountedUpstreamUrl,
  oauthSecretDueForRefresh,
  parseOAuthRefreshResponse,
} from "./provider-adapter.js";
import {
  epochMilliseconds,
  isQuotaRejection,
  quotaFromHeaders,
} from "./quota.js";
import { parseRequestBody } from "./request-body.js";
import { modelWeeklyFromUsage, quotaFromUsage } from "./usage.js";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const PROFILE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-app",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["anthropic-", "x-stainless-"];

const refreshResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    expires_at: z.number().positive().optional(),
  })
  .passthrough();

interface ProfileJob {
  context: AdapterUsageContext;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const profileJobs: ProfileJob[] = [];
const physicalProfiles = new Set<string>();
const MAX_PHYSICAL_PROFILES = 2;
let profileRunning = false;

function profileBlocked(id: string): boolean {
  return (
    physicalProfiles.has(id) || physicalProfiles.size >= MAX_PHYSICAL_PROFILES
  );
}

async function drainProfiles(): Promise<void> {
  if (profileRunning) return;
  profileRunning = true;
  try {
    while (profileJobs.length > 0) {
      const foreground = profileJobs.findIndex(
        (job) => !job.context.background,
      );
      const job = profileJobs.splice(foreground < 0 ? 0 : foreground, 1)[0]!;
      try {
        if (!job.context.signal?.aborted) await job.run();
        job.resolve();
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    profileRunning = false;
  }
}

function scheduleProfile(
  context: AdapterUsageContext,
  run: () => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    profileJobs.push({ context, run, resolve, reject });
    void drainProfiles();
  });
}

function profileJitter(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.floor(Math.random() * 2_001));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function requestProfile(
  context: AdapterUsageContext,
  url: string,
  accessToken: string,
): Promise<ClaudeProfile | null> {
  const id = context.account.id;
  if (profileBlocked(id)) return null;
  physicalProfiles.add(id);
  const deadline = new AbortController();
  const signal = AbortSignal.any([
    deadline.signal,
    ...(context.signal === undefined ? [] : [context.signal]),
  ]);
  const timer = setTimeout(() => deadline.abort(), USAGE_REQUEST_TIMEOUT_MS);
  let abort = () => {};
  const canceled = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const operation = (async () => {
    if (signal.aborted) return null;
    const response = await context
      .fetch(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal,
      })
      .catch(() => null);
    if (response === null) return null;
    if (signal.aborted || !response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const parsed = claudeProfileSchema.safeParse(
      await response.json().catch(() => null),
    );
    return signal.aborted || !parsed.success ? null : parsed.data;
  })().finally(() => physicalProfiles.delete(id));
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function createClaudeAdapter(options: {
  refreshUrl: string;
  usageUrl: string;
  profileUrl: string;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
}): ProviderAdapter {
  const profileCheckedAt = new Map<string, number>();
  const profileInFlight = new Map<string, AdapterUsageContext>();
  const profileRetryAt = new Map<string, number>();
  async function refreshProfile(context: AdapterUsageContext): Promise<void> {
    const id = context.account.id;
    if (profileInFlight.get(id)?.signal?.aborted) profileRetryAt.delete(id);
    if (
      context.account.kind !== "oauth" ||
      context.signal?.aborted ||
      profileBlocked(id) ||
      (profileInFlight.has(id) && !profileInFlight.get(id)?.signal?.aborted) ||
      context.now() < (profileRetryAt.get(id) ?? 0)
    )
      return;
    profileInFlight.set(id, context);
    profileRetryAt.set(id, context.now() + 5 * 60 * 1_000);
    let failed = true;
    let skipped = false;
    const result: { profile: ClaudeProfile | null } = { profile: null };
    try {
      await scheduleProfile(context, async () => {
        if (context.signal?.aborted) return;
        if (profileBlocked(id)) {
          skipped = true;
          return;
        }
        const secret = await context.freshSecret();
        if (secret.kind !== "oauth" || context.signal?.aborted) return;
        const account = context.account;
        const checkedAt = profileCheckedAt.get(account.id);
        if (
          account.accountUuid !== null &&
          (await context.accounts.planDisplayNames())[account.id] !==
            undefined &&
          checkedAt !== undefined &&
          context.now() - checkedAt < PROFILE_REFRESH_INTERVAL_MS
        ) {
          failed = false;
          return;
        }
        if (context.signal?.aborted) return;
        result.profile = await requestProfile(
          context,
          options.profileUrl,
          secret.accessToken,
        );
      });
      const profile = result.profile;
      if (profile === null || context.signal?.aborted) return;
      const account = context.account;
      const accountUuid = profile.account.uuid ?? null;
      if (account.accountUuid === null) {
        if (accountUuid === null) return;
        await context.accounts.setAccountUuid(
          account.id,
          accountUuid,
          context.signal,
        );
      } else if (accountUuid !== account.accountUuid) {
        return;
      }
      const organizationUuid = profile.organization?.uuid ?? null;
      if (organizationUuid !== null)
        await context.accounts.setOrganization(
          account.id,
          organizationUuid,
          context.signal,
        );
      await context.accounts.setPlanDisplayName(
        account.id,
        profile.organization?.plan_display_name ?? null,
        context.signal,
      );
      const reported = claudePlanFromProfile(profile);
      const plan = {
        subscriptionType: reported.subscriptionType ?? account.subscriptionType,
        rateLimitTier: reported.rateLimitTier ?? account.rateLimitTier,
      };
      if (
        plan.subscriptionType !== account.subscriptionType ||
        plan.rateLimitTier !== account.rateLimitTier
      )
        await context.accounts.setPlan(account.id, plan, context.signal);
      if (context.signal?.aborted) return;
      profileCheckedAt.set(account.id, context.now());
      failed = profile.organization?.plan_display_name == null;
    } finally {
      if (profileInFlight.get(id) === context) {
        if (context.signal?.aborted || skipped) profileRetryAt.delete(id);
        else profileRetryAt.set(id, context.now() + 5 * 60 * 1_000);
        profileInFlight.delete(id);
      }
      if (failed && !skipped && context.background)
        await profileJitter(context.signal);
    }
  }

  return {
    provider: "claude",
    refreshProfile,
    upstreamName: "Anthropic",
    async localLogin() {
      return null;
    },
    async importAccount() {
      const imported = await (
        options.importCredentials ?? importClaudeCredentials
      )();
      return {
        label: imported.email ?? "Claude Code account",
        email: imported.email,
        ...(imported.accountUuid === null
          ? {}
          : { accountUuid: imported.accountUuid }),
        ...(imported.organizationUuid === null
          ? {}
          : { organizationUuid: imported.organizationUuid }),
        subscriptionType: imported.subscriptionType,
        rateLimitTier: imported.rateLimitTier,
        secret: {
          kind: "oauth",
          accessToken: imported.accessToken,
          refreshToken: imported.refreshToken,
          expiresAt: imported.expiresAt,
        },
      };
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: parsed.family,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: (account) => parsed.forAccount(account.accountUuid),
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(request, settings.anthropicUpstreamBaseUrl),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      if (secret.kind === "oauth") {
        headers.set("authorization", `Bearer ${secret.accessToken}`);
      } else {
        headers.set("x-api-key", secret.apiKey);
      }
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      const secret = oauthSecretDueForRefresh(context);
      if (secret === null) return { secret: context.secret, refreshed: false };
      const parsed = parseOAuthRefreshResponse(
        await fetchOAuthRefresh(context, options.refreshUrl, {
          grant_type: "refresh_token",
          refresh_token: secret.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
        refreshResponseSchema,
      );
      const rawExpiresAt =
        parsed.expires_at ??
        (parsed.expires_in === undefined
          ? context.now() + 60 * 60 * 1_000
          : context.now() + parsed.expires_in * 1_000);
      const refreshed: AccountSecret = {
        kind: "oauth",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? secret.refreshToken,
        expiresAt: epochMilliseconds(rawExpiresAt),
        ...(secret.idToken === undefined ? {} : { idToken: secret.idToken }),
      };
      await context.accounts.writeSecret(context.account.id, refreshed);
      return { secret: refreshed, refreshed: true };
    },
    async refreshUsage(context) {
      if (context.account.kind !== "oauth") return;
      const secret = await context.freshSecret();
      if (secret.kind !== "oauth") return;
      const response = await context.fetch(options.usageUrl, {
        headers: {
          authorization: `Bearer ${secret.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Usage refresh failed.");
      }
      const payload: unknown = await response.json().catch(() => null);
      if (typeof payload !== "object" || payload === null)
        throw new Error("Usage refresh returned unreadable data.");
      const quota = quotaFromUsage(
        context.account.id,
        payload,
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota === null)
        throw new Error("Usage refresh returned unreadable data.");
      const models = modelWeeklyFromUsage(payload, context.now());
      const stored = await context.accounts.withExistingAccount(
        context.account.id,
        () => {
          context.quotas.put(quota);
          if (models !== null)
            context.quotas.putModelWeekly(context.account.id, models);
        },
      );
      if (!stored) return;
      if (profileRunning) void refreshProfile(context).catch(() => {});
      else await refreshProfile(context);
    },
    errorResponse(status, message, headers) {
      const type =
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";
      return Response.json(
        { type: "error", error: { type, message } },
        { status, headers },
      );
    },
  };
}
