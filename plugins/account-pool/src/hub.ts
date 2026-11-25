import type { ImportedProviderAccount } from "./provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import {
  retryAvailabilitySchema,
  type RetryAvailability,
} from "./retry-contract.js";
import { HUB_TOKEN_HEADER } from "./parent-pool.js";
import type {
  Account,
  AccountBalance,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ImportProbe,
  ModelFamily,
  PoolProvider,
  PoolStatus,
  LastAutomaticChoice,
} from "./contracts.js";
import { accountBalance, chooseBalancedCandidate } from "./balancer.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import {
  createGeminiAdapter,
  GEMINI_COMMIT_ERROR_PREFIX,
  DEFAULT_GEMINI_REFRESH_URL,
  DEFAULT_GEMINI_UPSTREAM_BASE_URLS,
  type GeminiUpstreamBaseUrls,
  geminiOAuthClientFromEnv,
  type GeminiOAuthClient,
} from "./gemini-adapter.js";
import type { ImportedGeminiCredentials } from "./gemini-credentials.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  isSignInRejection,
  OAuthRefreshError,
  TransientOAuthRefreshError,
} from "./provider-adapter.js";
import {
  accountStatus,
  blockingResetAt,
  hasExtraUsage,
  isPastThreshold,
  isQuotaExhausted,
  isUsageRestricted,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
  RoutingStore,
} from "./store.js";
import type { ThreadTokenStore, ThreadRoute } from "./thread-tokens.js";
import { parentRequestHeaders, type ParentPool } from "./parent-pool.js";
import {
  OAUTH_PROXY_HOST,
  TARGET_HOST_HEADER,
  TARGET_METHOD_HEADER,
  TARGET_PATH_HEADER,
  classifyOAuthProxyRequest,
  oauthProxyRouteLabel,
} from "./oauth-proxy-policy.js";

const ROUTE = "/api/v1/plugins/account-pool/http";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS = 30 * 1_000;
const TRANSIENT_USAGE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];
const MIN_USAGE_LOOP_DELAY_MS = 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_INLINE_PACING_MS = 2_000;
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000];
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const UPSTREAM_REJECTION_HOLD_MS = 60_000;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const MAX_BODY_REJECTION_BYTES = 16_384;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 65 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const OAUTH_PROXY_MAX_BODY_BYTES = 32 * 1_024 * 1_024;
const OAUTH_PROXY_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "content-encoding",
  "user-agent",
  "anthropic-beta",
  "x-app",
  "mcp-session-id",
  "mcp-protocol-version",
]);
const OAUTH_BETA_FLAG = "oauth-2025-04-20";
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: HubTokenStore;
  threadTokens: ThreadTokenStore;
  routing: RoutingStore | null;
  getSettings: () => AccountPoolConfig;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  mutationDrainTimeoutMs: number;
  onMutationDrainTimeout: (accountIds: string[]) => void;
  onPlanBackfillError: () => void;
  getParentRoute: () => ParentPool | null;
  onAccountsChanged: () => void;
  onActorRequest: (info: {
    provider: PoolProvider;
    hostId: string;
    threadId: string;
    actorId: string;
  }) => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  onStreamCut: (cut: StreamCut) => void;
  onClientRefused: (
    provider: PoolProvider,
    hostId: string,
    reason: string | null,
  ) => void;
  onOAuthRefresh: (
    provider: PoolProvider,
    accountId: string,
    outcome: "succeeded" | "failed",
    message: string,
  ) => void;
  onOAuthRelay: (relay: OAuthRelay) => void;
}

export interface OAuthRelay {
  method: string;
  route: string;
  upstream:
    | { kind: "status"; status: number }
    | { kind: "error"; errorClass: string };
  durationMs: number;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  automaticChoice: LastAutomaticChoice | null;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
  selectionAccountId: string | null;
}

export interface BindingPreview {
  boundAccountId: string | null;
  nextAccountId: string | null;
  reason: string;
  headroom: Array<{
    accountId: string;
    balance: AccountBalance;
    eligible: boolean;
  }>;
}

export interface NextAccountPreview {
  nextAccountId: string | null;
  reason: string;
}

interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
  trace?: StreamTrace;
}

interface StreamTrace {
  provider: PoolProvider;
  accountLabel: string;
  model: string | null;
  clientSignal: AbortSignal;
}

export interface StreamCut {
  provider: PoolProvider;
  accountLabel: string;
  model: string | null;
  at: number;
  requestId: string | null;
  bytes: number;
  events: number;
  elapsedMs: number;
  kind: "error" | "ended-early" | "client-closed";
  upstreamStreaming: boolean;
  errorName: string | null;
  causeCode: string | null;
  causeMessage: string | null;
  clientAborted: boolean;
}

interface FinalMarkers {
  events: readonly string[];
  isFinalData?: (payload: unknown) => boolean;
}

const MAX_PENDING_LINE = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function geminiCandidates(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const body = isRecord(payload.response) ? payload.response : payload;
  return Array.isArray(body.candidates) ? body.candidates : [];
}

function isGeminiFinalEvent(payload: unknown): boolean {
  return geminiCandidates(payload).some(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.finishReason === "string" &&
      candidate.finishReason !== "" &&
      candidate.finishReason !== "FINISH_REASON_UNSPECIFIED",
  );
}

const FINAL_EVENT_MARKERS: Partial<Record<PoolProvider, FinalMarkers>> = {
  claude: { events: ["message_stop"] },
  codex: {
    events: ["response.completed", "response.failed", "response.incomplete"],
  },
  gemini: { events: [], isFinalData: isGeminiFinalEvent },
};

interface RefreshBackoff {
  kind: "proactive" | "rejected" | "upstream";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check" | "replacement"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array | "too-large"> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class AccountPoolHub {
  private accepting = false;
  private mutationDrainWarned = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<boolean>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly transientUsageRetries = new Map<
    string,
    { attempts: number; delayMs: number }
  >();
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly options: HubOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.pacingByAccount.clear();
    this.stopped.abort();
    const lifecycle = new AbortController();
    this.stopped = lifecycle;
    this.planBackfill = null;
    this.mutationDrainWarned = false;
    const stop = () => lifecycle.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    this.accepting = true;
    void this.backfillPlanNames();
    try {
      while (!lifecycle.signal.aborted) {
        const delayMs = await abortable(
          this.refreshScheduledUsage(),
          lifecycle.signal,
        ).catch((error: unknown) => {
          if (!lifecycle.signal.aborted) throw error;
          return DEFAULT_USAGE_REFRESH_INTERVAL_MS;
        });
        await waitForDelay(delayMs, lifecycle.signal);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.stopped === lifecycle) {
        this.transientUsageRetries.clear();
        await this.stop();
      }
    }
  }

  async authenticateProvider(
    request: Request,
    provider: PoolProvider,
  ): Promise<string | null> {
    return (await this.authenticateRoute(request, provider)).hostId;
  }

  private async authenticateRoute(request: Request, provider: PoolProvider) {
    const token = presentedToken(request);
    const actorRoute = await this.options.threadTokens.authenticateActor(
      token,
      provider,
    );
    const authenticated =
      actorRoute ??
      (await this.options.threadTokens.authenticate(token, provider));
    const catalogHostId =
      authenticated === null
        ? await this.options.threadTokens.authenticateCatalog(token, provider)
        : null;
    const threadRoute: (ThreadRoute & { actorId?: string }) | null =
      authenticated === null ||
      actorRoute !== null ||
      !this.options.threadTokens.isProcessCredential(token) ||
      this.options.routing === null ||
      this.options.getParentRoute() !== null
        ? authenticated
        : {
            ...authenticated,
            accountId: await this.options.routing.selectedAccount(
              authenticated.threadId,
              provider,
            ),
          };
    const hostId =
      threadRoute?.hostId ??
      (await this.options.threadTokens.authenticateNested(token))?.hostId ??
      catalogHostId ??
      null;
    return { threadRoute, hostId, actorRoute };
  }

  async authenticateNested(request: Request): Promise<string | null> {
    const route = await this.options.threadTokens.authenticateNested(
      presentedToken(request),
    );
    return route?.hostId ?? null;
  }

  async importAccount(
    provider: PoolProvider,
    options?: { home?: string },
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount(options);
  }

  async probeImport(
    provider: PoolProvider,
    options?: { home?: string },
  ): Promise<ImportProbe> {
    const adapter = this.adapter(provider);
    if (adapter.probeImport === undefined)
      throw new Error(
        `${adapter.upstreamName} accounts have no import dry run.`,
      );
    return adapter.probeImport(options);
  }

  async replaceSecret(
    accountId: string,
    secret: AccountSecret,
    writeSecret: () => Promise<void> = () =>
      this.options.accounts.writeSecret(accountId, secret),
  ): Promise<void> {
    while (true) {
      const existing = this.refreshes.get(accountId);
      if (existing !== undefined) {
        await existing.result.then(
          () => undefined,
          () => undefined,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "replacement",
        result: writeSecret()
          .then(async () => {
            this.refreshBackoffs.delete(accountId);
            this.committedProjects.delete(accountId);
            await this.options.accounts.clearRejectedRefresh(accountId);
            this.setError(accountId, null);
          })
          .finally(() => {
            if (this.refreshes.get(accountId) === flight)
              this.refreshes.delete(accountId);
          }),
      };
      this.refreshes.set(accountId, flight);
      return flight.result;
    }
  }

  localLogin(
    provider: PoolProvider,
  ): Promise<{ email: string | null; planLabel: string | null } | null> {
    return this.adapter(provider).localLogin();
  }

  async handle(
    request: Request,
    provider: PoolProvider,
    routePath: string,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const { threadRoute, hostId, actorRoute } = await this.authenticateRoute(
      request,
      provider,
    );
    if (hostId === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    if (adapter.refuseClient !== undefined) {
      const refusal = adapter.refuseClient(request.headers);
      this.options.onClientRefused(provider, hostId, refusal);
      if (refusal !== null) return adapter.errorResponse(400, refusal);
    }
    if (
      threadRoute !== null &&
      (actorRoute !== null ||
        (threadRoute.accountId !== null &&
          threadRoute.accountId !== undefined)) &&
      this.options.routing !== null &&
      ((await this.options.routing.isBypassed(threadRoute.threadId)) ||
        !(await this.options.routing.isProviderEnabled(provider)))
    ) {
      return adapter.errorResponse(
        409,
        "Pooled routing is disabled for this conversation. Start a new turn to use its current routing settings.",
      );
    }
    if (actorRoute !== null) {
      this.options.onActorRequest({
        provider,
        hostId: actorRoute.hostId,
        threadId: actorRoute.threadId,
        actorId: actorRoute.actorId,
      });
    }
    const parent = this.options.getParentRoute();
    if (parent !== null) {
      if (
        threadRoute?.accountId !== undefined &&
        threadRoute.accountId !== null
      ) {
        return adapter.errorResponse(
          409,
          "An explicit subscription requires a local account pool. Choose Automatic while using a parent pool.",
        );
      }
      return this.forwardToParent(request, adapter, routePath, parent);
    }
    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      hostId,
      threadRoute,
    );
  }

  async handleOAuthProxy(request: Request): Promise<Response> {
    const adapter = this.adapter("claude");
    const { threadRoute, hostId } = await this.authenticateRoute(
      request,
      "claude",
    );
    if (hostId === null)
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    const method = request.headers.get(TARGET_METHOD_HEADER) ?? "";
    const target = request.headers.get(TARGET_PATH_HEADER) ?? "";
    if (
      threadRoute === null ||
      this.options.getParentRoute() !== null ||
      request.headers.get(TARGET_HOST_HEADER) !== OAUTH_PROXY_HOST ||
      classifyOAuthProxyRequest(method, target).kind !== "forward"
    )
      return adapter.errorResponse(
        403,
        "This Artifact request is not allowed through the Account Pooler.",
      );
    const declared = request.headers.get("content-length");
    if (declared !== null && !/^\d+$/u.test(declared.trim()))
      return adapter.errorResponse(400, "Invalid Content-Length.");
    if (declared !== null && Number(declared) > OAUTH_PROXY_MAX_BODY_BYTES)
      return adapter.errorResponse(413, "The Artifact request is too large.");
    const account = await this.oauthAccountForThread(threadRoute, hostId);
    if (account === null)
      return adapter.errorResponse(
        403,
        "Artifacts need a subscription account in the Account Pooler.",
      );
    const body =
      method === "GET" || method === "DELETE"
        ? null
        : await readBoundedBody(request, OAUTH_PROXY_MAX_BODY_BYTES);
    if (body === "too-large")
      return adapter.errorResponse(413, "The Artifact request is too large.");
    const url =
      this.options.getSettings().anthropicUpstreamBaseUrl.replace(/\/+$/u, "") +
      target;
    const startedAt = this.options.now();
    const relayed = (upstream: OAuthRelay["upstream"]) =>
      this.options.onOAuthRelay({
        method,
        route: oauthProxyRouteLabel(target),
        upstream,
        durationMs: this.options.now() - startedAt,
      });
    const { controller, release } = this.trackRequest(request);
    let handedOff = false;
    try {
      let secret = await abortable(
        this.freshSecret(account, adapter, { kind: "normal" }),
        controller.signal,
      );
      for (let attempt = 0; ; attempt += 1) {
        if (secret.kind !== "oauth")
          return adapter.errorResponse(
            403,
            "Artifacts need a subscription account in the Account Pooler.",
          );
        const headers = new Headers();
        for (const [name, value] of request.headers) {
          if (
            OAUTH_PROXY_REQUEST_HEADERS.has(name) ||
            name.startsWith("x-frame-")
          )
            headers.set(name, value);
        }
        const beta = headers.get("anthropic-beta");
        if (beta === null) headers.set("anthropic-beta", OAUTH_BETA_FLAG);
        else if (
          !beta.split(",").some((flag) => flag.trim() === OAUTH_BETA_FLAG)
        )
          headers.set("anthropic-beta", `${beta},${OAUTH_BETA_FLAG}`);
        headers.set("authorization", `Bearer ${secret.accessToken}`);
        let response: Response;
        try {
          response = await this.options.fetch(url, {
            method,
            headers,
            ...(body === null ? {} : { body: body as BodyInit }),
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (cause) {
          if (!controller.signal.aborted)
            this.options.onUpstreamError("claude", cause);
          relayed({
            kind: "error",
            errorClass:
              cause instanceof Error &&
              /^[A-Za-z0-9_$]{1,64}$/u.test(cause.name)
                ? cause.name
                : "Error",
          });
          return adapter.errorResponse(
            502,
            "Account Pooler could not reach Anthropic.",
          );
        }
        if (response.status === 401 && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          try {
            secret = await abortable(
              this.freshSecret(account, adapter, {
                kind: "rejected",
                accessToken: secret.accessToken,
              }),
              controller.signal,
            );
          } catch (error) {
            if (error instanceof TransientOAuthRefreshError)
              return adapter.errorResponse(503, error.message);
            return adapter.errorResponse(
              401,
              "Anthropic rejected the pooled account's sign-in.",
            );
          }
          continue;
        }
        const forwarded = new Headers(response.headers);
        forwarded.delete("set-cookie");
        relayed({ kind: "status", status: response.status });
        handedOff = true;
        return this.clientResponse({
          response: new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: forwarded,
          }),
          controller,
          release,
          trace: {
            provider: "claude",
            accountLabel: account.label,
            model: null,
            clientSignal: request.signal,
          },
        });
      }
    } catch (error) {
      if (request.signal.aborted)
        return adapter.errorResponse(
          499,
          "Account Pooler request was canceled.",
        );
      throw error;
    } finally {
      if (!handedOff) release();
    }
  }

  private async oauthAccountForThread(
    threadRoute: ThreadRoute,
    hostId: string,
  ): Promise<Account | null> {
    const claudeAccounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === "claude" && account.enabled,
    );
    if (threadRoute.accountId !== null && threadRoute.accountId !== undefined) {
      const pinned = claudeAccounts.find(
        (account) => account.id === threadRoute.accountId,
      );
      return pinned?.kind === "oauth" ? pinned : null;
    }
    const oauth = claudeAccounts.filter((account) => account.kind === "oauth");
    const byId = new Map(oauth.map((account) => [account.id, account]));
    let bound: Account | null = null;
    let boundAt = -1;
    for (const [key, binding] of this.affinityBindings) {
      const account = byId.get(binding.accountId);
      if (account === undefined || binding.lastUsedAt <= boundAt) continue;
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        continue;
      }
      if (
        Array.isArray(parts) &&
        parts[0] === "claude" &&
        parts[1] === hostId &&
        parts[2] === threadRoute.threadId
      ) {
        bound = account;
        boundAt = binding.lastUsedAt;
      }
    }
    if (bound !== null) return bound;
    const active = this.activeAccounts.get("claude");
    const activeAccount =
      active === undefined ? undefined : byId.get(active.accountId);
    if (activeAccount !== undefined) return activeAccount;
    const next = (await this.previewAccountChoice("claude")).nextAccountId;
    return (next === null ? undefined : byId.get(next)) ?? oauth[0] ?? null;
  }

  private trackRequest(
    request: Request,
    onRelease?: () => void,
  ): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        request.signal.removeEventListener("abort", abortFromRequest);
        this.activeControllers.delete(controller);
        onRelease?.();
      },
    };
  }

  private async forwardToParent(
    request: Request,
    adapter: ProviderAdapter,
    routePath: string,
    parent: ParentPool,
  ): Promise<Response> {
    const { controller, release } = this.trackRequest(request);
    try {
      const search = new URL(request.url).search;
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const response = await this.options
        .fetch(`${parent.baseUrl}${routePath}${search}`, {
          method: request.method,
          headers: parentRequestHeaders(request.headers, parent.token),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Parent pool unreachable.", {
            cause,
          });
        });
      return this.clientResponse({
        response,
        controller,
        release,
        trace: {
          provider: adapter.provider,
          accountLabel: "parent pool",
          model: null,
          clientSignal: request.signal,
        },
      });
    } catch (error) {
      release();
      if (request.signal.aborted)
        return adapter.errorResponse(
          499,
          "Account Pooler request was canceled.",
        );
      if (error instanceof UpstreamConnectionError)
        return adapter.errorResponse(
          502,
          "Account Pooler could not reach the parent pool.",
        );
      throw error;
    }
  }

  async refreshUsage(
    accountId?: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const listedAccounts = await this.options.accounts.list(signal);
    const requested =
      accountId === undefined
        ? undefined
        : listedAccounts.find((account) => account.id === accountId);
    if (
      accountId !== undefined &&
      requested?.provider === "gemini" &&
      (!requested.enabled || requested.kind !== "oauth")
    )
      return false;
    const accounts = listedAccounts.filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    signal?.throwIfAborted();
    const refreshed = await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(
          account,
          force ? 0 : DEFAULT_USAGE_REFRESH_INTERVAL_MS,
          force,
          signal,
        ),
      ),
    );
    return refreshed.every(Boolean);
  }

  private async refreshScheduledUsage(): Promise<number> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.enabled && account.kind === "oauth",
    );
    const listed = new Set(accounts.map((account) => account.id));
    for (const id of [...this.transientUsageRetries.keys()])
      if (!listed.has(id)) this.transientUsageRetries.delete(id);
    const existing = new Set(
      (await this.options.accounts.list()).map((account) => account.id),
    );
    for (const id of [...this.committedProjects.keys()])
      if (!existing.has(id)) this.committedProjects.delete(id);
    const before = new Map(
      accounts.map((account) => [
        account.id,
        this.lastUsageRefreshAt.get(account.id),
      ]),
    );
    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(
          account,
          this.transientUsageRetries.get(account.id)?.delayMs ??
            DEFAULT_USAGE_REFRESH_INTERVAL_MS,
        ),
      ),
    );
    const now = this.options.now();
    let next = DEFAULT_USAGE_REFRESH_INTERVAL_MS;
    for (const account of accounts) {
      const error = this.options.quotas.get(account.id).error;
      if (
        error === null ||
        this.adapter(account.provider).isTransientUsageError?.(error) !== true
      ) {
        this.transientUsageRetries.delete(account.id);
        continue;
      }
      const last = this.lastUsageRefreshAt.get(account.id);
      let retry = this.transientUsageRetries.get(account.id);
      if (retry === undefined || last !== before.get(account.id)) {
        const attempts = retry?.attempts ?? 0;
        retry = {
          attempts: attempts + 1,
          delayMs:
            TRANSIENT_USAGE_RETRY_DELAYS_MS[attempts] ??
            DEFAULT_USAGE_REFRESH_INTERVAL_MS,
        };
        this.transientUsageRetries.set(account.id, retry);
      }
      const due = (last ?? now) + retry.delayMs - now;
      next = Math.min(next, Math.max(MIN_USAGE_LOOP_DELAY_MS, due));
    }
    return next;
  }

  private async refreshExhaustedUsage(
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
  ): Promise<void> {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const accounts = (await this.options.accounts.list()).filter((account) => {
      if (
        !candidateIds.has(account.id) ||
        attempted.has(account.id) ||
        !account.enabled ||
        account.kind !== "oauth"
      )
        return false;
      const quota = this.options.quotas.get(account.id);
      return (
        quota.error === null && isPastThreshold(quota, family, threshold, now)
      );
    });
    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(account, EXHAUSTED_USAGE_REFRESH_INTERVAL_MS),
      ),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    minIntervalMs: number,
    recoverError = false,
    callerSignal?: AbortSignal,
  ): Promise<boolean> {
    const signal = AbortSignal.any([
      this.stopped.signal,
      ...(callerSignal === undefined ? [] : [callerSignal]),
    ]);
    signal.throwIfAborted();
    const adapter = this.adapter(account.provider);
    if (
      adapter.usageFromResponses &&
      (this.inFlightByAccount.get(account.id) ?? 0) > 0
    )
      return true;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (last !== undefined && now - last < minIntervalMs) return true;
    this.lastUsageRefreshAt.set(account.id, now);
    const recover =
      recoverError && this.options.quotas.get(account.id).error !== null;
    const refresh = adapter
      .refreshUsage({
        signal,
        account,
        freshSecret: (profileSignal = signal) =>
          this.freshSecret(
            account,
            adapter,
            { kind: "normal" },
            recover,
            profileSignal,
            true,
          ).catch((error: unknown) => {
            if (
              !profileSignal.aborted &&
              (recover || error instanceof OAuthRefreshError) &&
              !(error instanceof TransientOAuthRefreshError)
            )
              this.setError(account.id, errorMessage(error));
            throw error;
          }),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
        onProjectCommitted: (accountId, project) =>
          this.committedProjects.set(accountId, {
            project,
            createdAt: account.createdAt,
          }),
      })
      .then(
        () => true,
        () => false,
      )
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    const backfill = this.planBackfill;
    if (this.inFlightCount() > 0 || backfill !== null) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        Promise.all([
          backfill?.catch(() => {}),
          this.inFlightCount() === 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
        ]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.options.drainTimeoutMs);
        }),
      ]);
      if (timeout !== null) clearTimeout(timeout);
      if (this.inFlightCount() > 0) {
        for (const controller of this.activeControllers) {
          controller.abort(
            new Error(
              "Account Pooler stopped before the upstream response completed.",
            ),
          );
        }
      }
    }
    let mutationTimer: ReturnType<typeof setTimeout> | null = null;
    const drained = await Promise.race([
      this.options.accounts.drainMutations().then(() => true),
      new Promise<false>((resolve) => {
        mutationTimer = setTimeout(
          () => resolve(false),
          this.options.mutationDrainTimeoutMs,
        );
      }),
    ]);
    if (mutationTimer !== null) clearTimeout(mutationTimer);
    if (!drained && !this.mutationDrainWarned) {
      this.mutationDrainWarned = true;
      this.options.onMutationDrainTimeout(
        this.options.accounts.pendingPlanWrites(),
      );
    }
  }

  private planBackfill: Promise<void> | null = null;

  backfillPlanNames(): Promise<void> {
    if (this.stopped.signal.aborted) return Promise.resolve();
    if (this.planBackfill !== null) return this.planBackfill;
    const pass = this.fillPlanNames(this.stopped.signal)
      .catch(() => {
        this.options.onPlanBackfillError();
      })
      .finally(() => {
        if (this.planBackfill === pass) this.planBackfill = null;
      });
    this.planBackfill = pass;
    return pass;
  }

  private async fillPlanNames(signal: AbortSignal): Promise<void> {
    const plans = await this.options.accounts.planDisplayNames();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id),
    );
    for (const account of accounts) {
      if (signal.aborted) return;
      if (
        account.provider !== "claude" ||
        account.kind !== "oauth" ||
        plans[account.id] !== undefined
      )
        continue;
      const adapter = this.adapter(account.provider);
      await adapter
        .refreshProfile?.({
          account,
          signal,
          background: true,
          freshSecret: (profileSignal = signal) =>
            this.options.accounts.readSecret(account.id, profileSignal),
          accounts: this.options.accounts,
          quotas: this.options.quotas,
          fetch: this.options.fetch,
          now: this.options.now,
        })
        .catch(() => {});
    }
  }

  async display(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (signal === undefined) void this.backfillPlanNames();
    const accounts = await this.options.accounts.list(signal);
    signal?.throwIfAborted();
    const plans = await this.options.accounts.displayPlanNames(
      new Set(accounts.map(({ id }) => id)),
      signal,
    );
    signal?.throwIfAborted();
    return {
      plans: Object.fromEntries(
        accounts.flatMap(({ id }) =>
          plans[id] === undefined ? [] : [[id, plans[id]]],
        ),
      ),
      weekly: Object.fromEntries(
        accounts.flatMap(({ id }) => {
          const windows = this.options.quotas.modelWeekly(id);
          return windows === undefined ? [] : [[id, windows]];
        }),
      ),
    };
  }

  async status(
    signal?: AbortSignal,
  ): Promise<Omit<PoolStatus, "routing" | "parent">> {
    signal?.throwIfAborted();
    const now = this.options.now();
    const automaticChoices = this.options.affinity.loadAutomaticChoices();
    const accounts = (await this.options.accounts.list(signal)).sort(
      (left, right) => left.priority - right.priority,
    );
    signal?.throwIfAborted();
    const organizations = await this.options.accounts.organizations(signal);
    signal?.throwIfAborted();
    const hosts = await this.options.hubTokens.list();
    signal?.throwIfAborted();
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts,
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;
        return {
          ...account,
          active:
            this.activeAccounts.get(account.provider)?.accountId === account.id,
          balance: accountBalance(account.provider, quota, null, now),
          lastAutomaticChoice:
            automaticChoices.get(`${account.provider}:${account.id}`) ?? null,
          lastUsedHostName: null,
          ...quotaFields,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status: accountStatus(account, quota, now),
          signInExpired: isSignInRejection(quota.error),
          organizationUuid: organizations.get(account.id) ?? null,
        };
      }),
    };
  }

  async bindingPreview(
    threadId: string | null,
    provider: "claude" | "gemini" = "claude",
  ): Promise<BindingPreview> {
    const preview = await this.previewAccountChoice(provider);
    const now = this.options.now();
    let binding: AccountBinding | null = null;
    for (const [key, value] of this.affinityBindings) {
      let identity: unknown;
      try {
        identity = JSON.parse(key);
      } catch {
        continue;
      }
      if (
        Array.isArray(identity) &&
        identity[0] === provider &&
        identity[2] === threadId &&
        value.lastUsedAt > (binding?.lastUsedAt ?? 0) &&
        now - value.lastUsedAt < AFFINITY_IDLE_TTL_MS
      )
        binding = value;
    }
    const bindingEligibleIds = new Set(preview.bindingEligibleAccountIds);
    const status = await this.options.accounts.list();
    const account =
      binding === null
        ? null
        : status.find(
            (candidate) =>
              candidate.id === binding?.accountId &&
              candidate.provider === provider &&
              candidate.enabled &&
              bindingEligibleIds.has(candidate.id),
          );
    const headroom = preview.headroom;
    return {
      boundAccountId: account?.id ?? null,
      nextAccountId: preview.nextAccountId,
      reason: preview.reason,
      headroom,
    };
  }

  async nextAccountPreview(provider: PoolProvider): Promise<
    NextAccountPreview & {
      headroom: Array<{
        accountId: string;
        balance: AccountBalance;
        eligible: boolean;
      }>;
    }
  > {
    const preview = await this.previewAccountChoice(provider);
    return {
      nextAccountId: preview.nextAccountId,
      reason: preview.reason,
      headroom: preview.headroom,
    };
  }

  private async previewAccountChoice(provider: PoolProvider): Promise<
    NextAccountPreview & {
      headroom: Array<{
        accountId: string;
        balance: AccountBalance;
        eligible: boolean;
      }>;
      bindingEligibleAccountIds: string[];
    }
  > {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const enabled = (await this.options.accounts.list()).filter(
      (account) => account.provider === provider && account.enabled,
    );
    const available = enabled
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(
        ({ account, quota }) =>
          !this.usageErrorBlocks(account.provider, quota.error) &&
          !isUsageRestricted(quota, now) &&
          (!isQuotaExhausted(quota, null, now) ||
            hasExtraUsage(quota)),
      );
    const usable = available.filter(
      ({ quota }) => !isQuotaExhausted(quota, "other", now) || hasExtraUsage(quota),
    );
    const accepted = usable.filter(({ quota }) => !isQuotaExhausted(quota, "other", now));
    const included = accepted.filter(({ quota }) => !isPastThreshold(quota, "other", threshold, now));
    let eligible = [included, accepted].find((tier) =>
      tier.some(({ quota }) => quota.heldUntil === null || quota.heldUntil <= now),
    ) ?? usable;
    const bindingEligibleAccountIds = (eligible === usable ? usable : accepted).map(({ account }) => account.id);
    eligible = eligible.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    const eligibleIds = new Set(eligible.map(({ account }) => account.id));
    const choice = chooseBalancedCandidate(
      eligible,
      "other",
      now,
      this.activeAccounts.get(provider)?.accountId ?? null,
    );
    return {
      nextAccountId: choice.candidate?.account.id ?? null,
      reason: choice.reason,
      headroom: enabled.map((account) => ({
        accountId: account.id,
        balance: accountBalance(account.provider, this.options.quotas.get(account.id), null, now),
        eligible: eligibleIds.has(account.id),
      })),
      bindingEligibleAccountIds,
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    hostId: string,
    threadRoute: (ThreadRoute & { actorId?: string }) | null = null,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
      selectionAccountId: threadRoute?.accountId ?? null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    let usageRefreshed = false;
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.provider === adapter.provider &&
        (routing.selectionAccountId === null ||
          account.id === routing.selectionAccountId),
    );
    if (routing.selectionAccountId !== null && accounts.length === 0) {
      return adapter.errorResponse(
        404,
        "The selected subscription no longer exists. Choose another subscription or Automatic.",
      );
    }
    const candidateIds = new Set(accounts.map((account) => account.id));
    const requestUrl = new URL(request.url);
    const parsed = adapter.parseRequest(body, request.headers, requestUrl);
    const family = parsed.family;
    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify(
            threadRoute === null
              ? [adapter.provider, hostId, parsed.affinityId]
              : threadRoute.actorId === undefined
                ? [
                    adapter.provider,
                    hostId,
                    threadRoute.threadId,
                    parsed.affinityId,
                  ]
                : [
                    adapter.provider,
                    hostId,
                    threadRoute.threadId,
                    threadRoute.actorId,
                    parsed.affinityId,
                  ],
          );
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify(
            threadRoute === null
              ? [adapter.provider, hostId, parsed.parentAffinityId]
              : threadRoute.actorId === undefined
                ? [
                    adapter.provider,
                    hostId,
                    threadRoute.threadId,
                    parsed.parentAffinityId,
                  ]
                : [
                    adapter.provider,
                    hostId,
                    threadRoute.threadId,
                    threadRoute.actorId,
                    parsed.parentAffinityId,
                  ],
          );
    try {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
          parsed.unmetered === true,
        );
        if (
          !usageRefreshed &&
          parsed.unmetered !== true &&
          (selected === null ||
            isPastThreshold(
              selected.quota,
              family,
              this.options.getSettings().switchThreshold,
              this.options.now(),
            ))
        ) {
          usageRefreshed = true;
          await abortable(
            this.refreshExhaustedUsage(candidateIds, attempted, family),
            signal,
          );
          continue;
        }
        if (selected === null) break;
        let pacing: PacingFlight | null = null;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        let activePacing = this.pacingByAccount.get(selected.account.id);
        if (
          activePacing !== undefined &&
          (activePacing.heldUntil !== selected.quota.heldUntil || heldMs <= 0)
        ) {
          this.releasePacing(selected.account.id, activePacing);
          activePacing = undefined;
        }
        if (heldMs > 0) {
          if (activePacing !== undefined) {
            pacing = activePacing;
            waited.add(selected.account.id);
            await abortable(activePacing.result, signal);
          } else if (
            heldMs > MAX_INLINE_HOLD_MS ||
            waited.has(selected.account.id) ||
            (adapter.provider === "gemini" &&
              (heldMs > MAX_INLINE_PACING_MS ||
                candidateIds.size > attempted.size + 1))
          ) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          } else {
            waited.add(selected.account.id);
            await waitForDelay(heldMs, signal);
            continue;
          }
        }
        attempted.add(selected.account.id);
        previousAccountId = selected.account.id;
        const changed = await this.options.accounts.recordUsed(
          selected.account.id,
          this.options.now(),
          hostId,
        );
        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.setError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        if (parsed.prepare !== undefined) {
          try {
            await abortable(
              parsed.prepare(selected.account, secret, signal),
              signal,
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            throw error;
          }
        }
        let authRetried = false;
        let transientRetries = 0;
        let paced = waited.has(selected.account.id);
        const retryTransient = async (
          retryAfter: string | null,
        ): Promise<boolean> => {
          if (!selected.keepAffinity) return false;
          const delayMs = transientRetryDelay(
            transientRetries,
            retryAfter,
            this.options.now(),
          );
          if (delayMs === null) return false;
          transientRetries++;
          await waitForDelay(delayMs, signal);
          signal.throwIfAborted();
          return true;
        };
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          try {
            upstream = await this.fetchUpstream(
              request,
              parsed.forAccount(selected.account),
              selected.account,
              secret,
              adapter,
              parsed.upstreamMethod,
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            if (await retryTransient(null)) continue;
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const observe = (stored: AccountQuota): AccountQuota =>
            adapter.quotaFromHeaders(
              selected.account.id,
              response.headers,
              stored,
              family,
              this.options.now(),
            );
          this.putObservedQuota(selected.account, observe);
          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          if (response.status === 429) {
            let bodyDetail: string | null = null;
            if (adapter.isQuotaRejection(response.headers)) {
              await this.discardUpstream(upstream, false);
              break;
            }
            if (adapter.quotaRejectionFromBody !== undefined) {
              const detail = await this.discardUpstream(
                upstream,
                true,
                MAX_BODY_REJECTION_BYTES,
              );
              signal.throwIfAborted();
              const rejection = adapter.quotaRejectionFromBody(
                detail,
                this.options.now(),
              );
              if (rejection !== null) {
                this.putObservedQuota(selected.account, (stored) => ({
                  ...observe(stored),
                  usageRestriction: {
                    reason: rejection.reason,
                    resetAt: rejection.resetAt,
                  },
                }));
                failure = {
                  status: 429,
                  message: rejection.message,
                  headers: {},
                };
                break;
              }
              bodyDetail = detail;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            const heldUntil = this.options.now() + waitMs;
            this.putObservedQuota(selected.account, (stored) => ({
              ...observe(stored),
              heldUntil,
            }));
            if (
              !paced &&
              waitMs <= MAX_INLINE_HOLD_MS &&
              (adapter.provider !== "gemini" ||
                (waitMs <= MAX_INLINE_PACING_MS &&
                  candidateIds.size <= attempted.size))
            ) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              if (bodyDetail === null)
                await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }
            if (!selected.keepAffinity || bodyDetail !== null) {
              failure = {
                status: 429,
                message:
                  bodyDetail ?? (await this.discardUpstream(upstream, true)),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            const rejected = response.status === 401 || response.status === 403;
            if (!rejected) {
              if (await retryTransient(retryAfter)) continue;
              break;
            }
            if (secret.kind === "oauth" && !authRetried) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  const message = errorMessage(error);
                  await this.rejectCredential(
                    selected.account,
                    secret,
                    signal,
                    () => this.setError(selected.account.id, message),
                  );
                }
                break;
              }
              continue;
            }
            if (secret.kind === "oauth") {
              const accessToken = secret.accessToken;
              const hold = new TransientOAuthRefreshError(
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  " for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure: " +
                  failure.message,
                0,
              );
              failure = { status: 503, message: hold.message, headers: {} };
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () =>
                  this.holdUpstreamRejection(
                    selected.account.id,
                    accessToken,
                    hold,
                  ),
              );
            } else {
              const message = failure.message;
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () => this.setError(selected.account.id, message),
              );
            }
            break;
          }
          if (response.ok) selected.accept();
          if (response.ok && adapter.transformResponse !== undefined) {
            const accountId = selected.account.id;
            upstream = {
              ...upstream,
              response: adapter.transformResponse(response, {
                url: requestUrl,
                account: selected.account,
                onQuotaRejection: ({ reason, resetAt }) =>
                  this.putObservedQuota(selected.account, (stored) => ({
                    ...stored,
                    usageRestriction: { reason, resetAt },
                  })),
              }),
            };
          }
          return this.clientResponse({
            ...upstream,
            trace: {
              provider: adapter.provider,
              accountLabel: selected.account.label,
              model: family,
              clientSignal: request.signal,
            },
          });
        }
      }
      signal.throwIfAborted();
      return failure === null
        ? this.noEligibleResponse(accounts, family, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
    maxBytes: number = MAX_FAILURE_DETAIL_BYTES,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < maxBytes) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              maxBytes - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async rejectCredential(
    account: Account,
    rejected: AccountSecret,
    signal: AbortSignal,
    apply: () => void,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      apply();
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff !== undefined &&
                backoff.kind !== "proactive" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              apply();
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
    unmetered: boolean,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => {
        const quota = this.options.quotas.get(account.id);
        return {
          account,
          quota: unmetered
            ? {
                ...quota,
                limitWindows: [],
                familyWeekly: {
                  fable: null,
                  sonnet: null,
                  opus: null,
                  haiku: null,
                  other: null,
                },
                usageRestriction: null,
                heldUntil: null,
              }
            : quota,
        };
      })
      .filter(
        ({ account, quota }) =>
          !this.usageErrorBlocks(account.provider, quota.error) &&
          !isUsageRestricted(quota, now),
      )
      .filter(
        ({ quota }) =>
          !isQuotaExhausted(quota, null, now) || hasExtraUsage(quota),
      );
    const usable = available.filter(
      ({ quota }) =>
        !isQuotaExhausted(quota, family, now) || hasExtraUsage(quota),
    );
    const isUnattempted = ({ account }: (typeof usable)[number]) =>
      candidateIds.has(account.id) && !attempted.has(account.id);
    const included = usable.filter(
      ({ quota }) => !isPastThreshold(quota, family, threshold, now),
    );
    const accepted = usable.filter(
      ({ quota }) =>
        !isQuotaExhausted(quota, family, now),
    );
    const eligible =
      [included, accepted].find((tier) =>
        tier.some(
          (candidate) =>
            isUnattempted(candidate) &&
            (candidate.quota.heldUntil === null ||
              candidate.quota.heldUntil <= now),
        ),
      ) ?? usable;
    const pinnable = eligible === usable ? usable : accepted;
    const unattempted = eligible.filter(isUnattempted);
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? pinnable.find(({ account }) => account.id === boundAccountId)
        : undefined;
    const boundIsHeld =
      bound !== undefined &&
      bound.quota.heldUntil !== null &&
      bound.quota.heldUntil > now;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = pinnable.find(
          (candidate) =>
            candidate.account.id === parent.accountId &&
            isUnattempted(candidate),
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const balancing = provider === "claude" || provider === "gemini";
    const balanced =
      balancing
        ? chooseBalancedCandidate(
            candidates,
            family,
            now,
            activeAccount?.account.id ?? null,
          )
        : {
            candidate: candidates[0] ?? null,
            reason: "priority tie-break",
          };
    const selectedBound =
      bound !== undefined && isUnattempted(bound) ? bound : null;
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const legacyAutomatic =
      boundAccountId === null &&
      previousAccountId === null &&
      activeAccount !== undefined &&
      unattempted.includes(activeAccount)
        ? activeAccount
        : (next ?? null);
    const selected =
      selectedBound ??
      inherited ??
      (balancing ? balanced.candidate : legacyAutomatic);
    if (selected === null) return null;
    const choiceReason =
      selectedBound !== null || inherited !== undefined
        ? null
        : balanced.reason;
    const automaticChoice =
      !balancing ||
      choiceReason === null ||
      routing.selectionAccountId !== null
        ? null
        : {
            chosenAt: now,
            reason: choiceReason,
            family,
            balance: accountBalance(provider, selected.quota, family, now),
          };
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: selected.account.id };
      if (routing.selectionAccountId === null)
        this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(
        ({ account, quota }) =>
          account.id === accountId &&
          !isPastThreshold(quota, null, threshold, now) &&
          isPastThreshold(quota, family, threshold, now),
      );
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding &&
          attempted.has(bound.account.id) &&
          !boundIsHeld));
    const advance =
      routing.selectionAccountId === null &&
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)) ||
        (balancing && automaticChoice !== null));
    return {
      ...selected,
      keepAffinity:
        selected.account.id === routing.pinnedAccountId &&
        (!balancing || routing.selectionAccountId !== null),
      automaticChoice,
      accept: () => {
        if (automaticChoice !== null) {
          this.options.affinity.putAutomaticChoice(
            provider,
            selected.account.id,
            automaticChoice,
          );
        }
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(
            provider,
            selected.account.id,
          );
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
    recover = false,
    signal?: AbortSignal,
    usageRefresh = false,
  ): Promise<AccountSecret> {
    while (true) {
      signal?.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind !== "refresh") {
          await existing.result;
          signal?.throwIfAborted();
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind !== "proactive"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id, signal)
          .then(async (secret) => {
            signal?.throwIfAborted();
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              recover || explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const rejection =
              secret.kind === "oauth"
                ? await this.options.accounts.rejectedRefresh(
                    account.id,
                    secret.refreshToken,
                  )
                : null;
            const error = this.options.quotas.get(account.id).error;
            if (
              !recover &&
              this.usageErrorBlocks(account.provider, error) &&
              !(
                usageRefresh &&
                adapter.isTransientUsageError?.(error) === true
              )
            )
              throw new Error(error);
            if (rejection?.sameToken && !recover && secret.kind === "oauth") {
              if (
                !forceRefresh &&
                rejection.message.startsWith(
                  "OAuth refresh failed with HTTP 400.",
                ) &&
                accessTokenUnexpired(secret, this.options.now())
              )
                return secret;
              throw new OAuthRefreshError(rejection.message);
            }
            if (
              !recover &&
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind !== "proactive")
            ) {
              if (
                backoff.kind === "proactive" &&
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              signal?.throwIfAborted();
              const result = await adapter.refreshSecret({
                signal,
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              signal?.throwIfAborted();
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                this.options.onOAuthRefresh(
                  account.provider,
                  account.id,
                  "succeeded",
                  `previousExpiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, expiresAt=${result.secret.kind === "oauth" ? result.secret.expiresAt : null}, forced=${forceRefresh}.`,
                );
                const storedError = this.options.quotas.get(account.id).error;
                if (
                  storedError === null ||
                  adapter.isTransientUsageError?.(storedError) !== true
                )
                  this.setError(account.id, null);
              }
              if (rejection !== null)
                await this.options.accounts.clearRejectedRefresh(account.id);
              return result.secret;
            } catch (error) {
              signal?.throwIfAborted();
              this.options.onOAuthRefresh(
                account.provider,
                account.id,
                "failed",
                `${error instanceof OAuthRefreshError ? error.message : "Stored credential refresh failed."} expiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, forced=${forceRefresh}.`,
              );
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                if (
                  error instanceof OAuthRefreshError &&
                  secret.kind === "oauth"
                ) {
                  await this.options.accounts.recordRejectedRefresh(
                    account.id,
                    secret.refreshToken,
                    error.message,
                  );
                  if (
                    !forceRefresh &&
                    error.message.startsWith(
                      "OAuth refresh failed with HTTP 400.",
                    ) &&
                    accessTokenUnexpired(secret, this.options.now())
                  )
                    return secret;
                }
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
    method = request.method,
  ): Promise<UpstreamResult> {
    this.increment(account.id);
    const { controller, release } = this.trackRequest(request, () =>
      this.decrement(account.id),
    );
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(
        request,
        this.options.getSettings(),
        account,
      );
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const response = await this.options
        .fetch(url, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const trace = upstream.trace;
    const requestId =
      upstream.response.headers.get("request-id") ??
      upstream.response.headers.get("x-request-id");
    const markers =
      trace === undefined ? undefined : FINAL_EVENT_MARKERS[trace.provider];
    const startedAt = this.options.now();
    const decoder = new TextDecoder();
    let bytes = 0;
    let events = 0;
    let finalSeen = false;
    let pendingLine = "";
    let skipLeadingLineFeed = false;
    let eventName = "";
    let dataLines: string[] = [];
    let finished = false;
    const endEvent = () => {
      events += 1;
      if (markers?.events.includes(eventName)) finalSeen = true;
      if (markers?.isFinalData !== undefined && dataLines.length > 0) {
        try {
          if (markers.isFinalData(JSON.parse(dataLines.join("\n"))))
            finalSeen = true;
        } catch {
          dataLines = [];
        }
      }
      eventName = "";
      dataLines = [];
    };
    const readLine = (line: string) => {
      const field = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (field === "") endEvent();
      else if (field.startsWith("event:"))
        eventName = field.slice("event:".length).trim();
      else if (field.startsWith("data:"))
        dataLines.push(field.slice("data:".length).replace(/^ /u, ""));
    };
    const reportCut = (
      kind: StreamCut["kind"],
      error: unknown,
      upstreamStreaming: boolean,
    ) => {
      if (trace === undefined) return;
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause
          : undefined;
      const now = this.options.now();
      this.options.onStreamCut({
        provider: trace.provider,
        accountLabel: trace.accountLabel,
        model: trace.model,
        at: now,
        requestId,
        bytes,
        events,
        elapsedMs: now - startedAt,
        kind,
        upstreamStreaming,
        errorName: error instanceof Error ? error.name : null,
        causeCode:
          (error instanceof Error ? errorCode(error) : null) ??
          (cause === undefined ? null : errorCode(cause)),
        causeMessage: cause?.message ?? null,
        clientAborted: trace.clientSignal.aborted,
      });
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (eventStream && markers !== undefined) {
              if (!finalSeen) reportCut("ended-early", undefined, false);
            }
            finished = true;
            upstream.release();
            controller.close();
          } else {
            bytes += chunk.value.byteLength;
            if (eventStream && markers !== undefined) {
              let text = decoder.decode(chunk.value, { stream: true });
              if (skipLeadingLineFeed && text !== "") {
                if (text.startsWith("\n")) text = text.slice(1);
                skipLeadingLineFeed = false;
              }
              if (text.endsWith("\r")) skipLeadingLineFeed = true;
              const lines = (pendingLine + text).split(/\r\n|\r|\n/u);
              pendingLine = (lines.pop() ?? "").slice(0, MAX_PENDING_LINE);
              for (const line of lines) readLine(line);
            }
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          finished = true;
          reportCut("error", error, false);
          upstream.release();
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel(reason: unknown) {
        if (!finished && !finalSeen)
          reportCut(
            "client-closed",
            reason ?? trace?.clientSignal.reason,
            true,
          );
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  async retryAvailability(
    provider: PoolProvider,
    family: ModelFamily,
  ): Promise<RetryAvailability> {
    const parent = this.options.getParentRoute();
    if (parent !== null) {
      try {
        const response = await this.options.fetch(
          `${parent.baseUrl}/retry-availability?provider=${provider}&family=${family}`,
          {
            headers: { [HUB_TOKEN_HEADER]: parent.token },
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (response.ok)
          return retryAvailabilitySchema.parse(await response.json());
        await response.body?.cancel();
      } catch {
        return { kind: "unavailable", reason: "source-unavailable" };
      }
      return { kind: "unavailable", reason: "source-unavailable" };
    }
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === provider,
    );
    return this.accountAvailability(accounts, family);
  }

  private accountAvailability(
    accounts: readonly Account[],
    family: ModelFamily,
  ): RetryAvailability {
    const enabled = accounts.filter((account) => account.enabled);
    if (enabled.length === 0)
      return { kind: "unavailable", reason: "no-enabled-account" };
    const now = this.options.now();
    const resets: number[] = [];
    let unknown = false;
    for (const account of enabled) {
      const quota = this.options.quotas.get(account.id);
      if (this.usageErrorBlocks(account.provider, quota.error)) continue;
      if (isUsageRestricted(quota, now)) {
        unknown = true;
        continue;
      }
      const exhausted =
        isQuotaExhausted(quota, family, now) && !hasExtraUsage(quota);
      const resetAt = exhausted
        ? blockingResetAt(quota, family, now)
        : now;
      if (resetAt === null) {
        unknown = true;
        continue;
      }
      const availableAt = Math.max(resetAt, quota.heldUntil ?? 0);
      if (availableAt <= now) return { kind: "ready" };
      resets.push(availableAt);
    }
    return resets.length > 0
      ? { kind: "blocked", retryAt: Math.min(...resets) }
      : {
          kind: "unavailable",
          reason: unknown ? "reset-unknown" : "authentication",
        };
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }
    const now = this.options.now();
    const availability = this.accountAvailability(accounts, family);
    const next =
      availability.kind === "blocked" ? availability.retryAt : undefined;
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      next === undefined
        ? "No Account Pooler account is currently eligible."
        : `No Account Pooler account is currently eligible. Next account is expected to be available at ${new Date(next).toISOString()} (in ${retryAfter} seconds).`,
      { "retry-after": String(retryAfter) },
    );
  }

  private holdUpstreamRejection(
    accountId: string,
    accessToken: string,
    error: TransientOAuthRefreshError,
  ): void {
    this.refreshBackoffs.delete(accountId);
    this.refreshBackoffs.set(accountId, {
      kind: "upstream",
      accessToken,
      retryAt: this.options.now() + UPSTREAM_REJECTION_HOLD_MS,
      delayMs: UPSTREAM_REJECTION_HOLD_MS,
      error,
    });
    while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
      const oldest = this.refreshBackoffs.keys().next();
      if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
    }
  }

  private putQuota(quota: AccountQuota): void {
    const stored = this.options.quotas.get(quota.accountId).error;
    this.options.quotas.put(
      stored?.startsWith(GEMINI_COMMIT_ERROR_PREFIX) === true &&
        quota.error !== stored
        ? { ...quota, error: stored }
        : quota,
    );
  }

  private readonly committedProjects = new Map<
    string,
    { project: string; createdAt: number }
  >();

  private putObservedQuota(
    sentOn: Account,
    change: (stored: AccountQuota) => AccountQuota,
  ): void {
    const stored = this.options.quotas.get(sentOn.id);
    if (stored.error?.startsWith(GEMINI_COMMIT_ERROR_PREFIX) === true) return;
    const committed = this.committedProjects.get(sentOn.id);
    if (committed !== undefined && committed.createdAt !== sentOn.createdAt)
      this.committedProjects.delete(sentOn.id);
    else if (
      committed !== undefined &&
      committed.project !== sentOn.geminiProject
    )
      return;
    this.putQuota(change(stored));
  }

  private setError(accountId: string, message: string | null): void {
    const quota = this.options.quotas.get(accountId);
    const error = message?.slice(0, 1_000) ?? null;
    if (quota.error === error) return;
    this.putQuota({ ...quota, error });
    this.options.onAccountsChanged();
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private usageErrorBlocks(
    provider: PoolProvider,
    error: string | null,
  ): error is string {
    return (
      error !== null &&
      this.adapter(provider).isNonBlockingUsageError?.(error) !== true
    );
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  threadTokens: ThreadTokenStore;
  routing?: RoutingStore;
  getSettings: () => AccountPoolConfig;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  geminiRefreshUrl?: string;
  geminiUserinfoUrl?: string;
  geminiOAuthClient?: GeminiOAuthClient;
  geminiUpstreamBaseUrls?: GeminiUpstreamBaseUrls;
  geminiRuntimeUserAgent?: () => Promise<string>;
  importGeminiCredentials?: (
    home?: string,
  ) => Promise<ImportedGeminiCredentials>;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  usageUrl?: string;
  profileUrl?: string;
  drainTimeoutMs?: number;
  mutationDrainTimeoutMs?: number;
  onMutationDrainTimeout?: (accountIds: string[]) => void;
  onPlanBackfillError?: () => void;
  maxAffinityBindings?: number;
  getParentRoute?: () => ParentPool | null;
  onAccountsChanged?: () => void;
  onActorRequest?: HubOptions["onActorRequest"];
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  onStreamCut?: HubOptions["onStreamCut"];
  onOAuthRefresh?: HubOptions["onOAuthRefresh"];
  onOAuthRelay?: HubOptions["onOAuthRelay"];
  onClientRefused?: HubOptions["onClientRefused"];
  onGeminiModels?: (accountId: string, ids: readonly string[], servedIds: readonly string[]) => void;
  geminiSavedModels?: () => Readonly<Record<string, readonly string[] | { served: readonly string[]; aliases: readonly string[] }>>;
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        importCredentials: options.importClaudeCredentials,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        importCredentials: options.importCodexCredentials,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
      }),
    ],
    [
      "gemini",
      createGeminiAdapter({
        refreshUrl: options.geminiRefreshUrl ?? DEFAULT_GEMINI_REFRESH_URL,
        userinfoUrl: options.geminiUserinfoUrl,
        oauthClient:
          options.geminiOAuthClient ?? geminiOAuthClientFromEnv(process.env),
        upstreamBaseUrls:
          options.geminiUpstreamBaseUrls ?? DEFAULT_GEMINI_UPSTREAM_BASE_URLS,
        importCredentials: options.importGeminiCredentials,
        onModels: options.onGeminiModels,
        savedModels: options.geminiSavedModels,
        runtimeUserAgent:
          options.geminiRuntimeUserAgent ??
          (() =>
            Promise.reject(
              new Error(
                "bb has no antigravity-acp runtime to read its version from, so it cannot send the Antigravity User-Agent to Gemini Code Assist.",
              ),
            )),
        fetch: options.fetch,
        now: options.now,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    threadTokens: options.threadTokens,
    routing: options.routing ?? null,
    getSettings: options.getSettings,
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    drainTimeoutMs: options.drainTimeoutMs ?? 60_000,
    mutationDrainTimeoutMs: options.mutationDrainTimeoutMs ?? 3_000,
    onMutationDrainTimeout: options.onMutationDrainTimeout ?? (() => {}),
    onPlanBackfillError: options.onPlanBackfillError ?? (() => {}),
    getParentRoute: options.getParentRoute ?? (() => null),
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onActorRequest: options.onActorRequest ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    onStreamCut: options.onStreamCut ?? (() => {}),
    onOAuthRefresh: options.onOAuthRefresh ?? (() => {}),
    onOAuthRelay: options.onOAuthRelay ?? (() => {}),
    onClientRefused: options.onClientRefused ?? (() => {}),
  });
}

function presentedToken(request: Request): string | null {
  return (
    request.headers.get("x-bb-account-pool-token") ??
    readBearer(request.headers.get("authorization"))
  );
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function accessTokenUnexpired(
  secret: Extract<AccountSecret, { kind: "oauth" }>,
  now: number,
): boolean {
  return secret.expiresAt === null || secret.expiresAt > now;
}

function errorCode(error: Error): string | null {
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transientRetryDelay(
  retries: number,
  retryAfter: string | null,
  now: number,
): number | null {
  const backoffMs = TRANSIENT_RETRY_DELAYS_MS[retries];
  if (backoffMs === undefined) return null;
  const delayMs =
    retryAfter === null ? backoffMs : retryAfterMilliseconds(retryAfter, now);
  return delayMs <= MAX_INLINE_HOLD_MS ? delayMs : null;
}

export function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
