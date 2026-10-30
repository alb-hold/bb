import {
  retryAvailabilityContract,
  retryAvailabilityMethod,
  type RetryAvailability,
} from "./retry-contract.js";
import { modelFamily } from "./quota.js";
import { registerUsageSource } from "./usage-source.js";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import { createHash } from "node:crypto";
import { ARCHIVE_UNDO_GRACE_MS, type Thread } from "@bb/domain";
import path from "node:path";
import { z } from "zod";
import type {
  BbPluginApi,
  ExperimentalPluginProviderEnvContext,
} from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  draftSelectionSchema,
  modelFamilySchema,
  poolAvailabilitySchema,
  type AccountPoolConfigController,
  type PoolProvider,
  type PoolStatus,
} from "./contracts.js";
import { ThreadTokenStore, type ThreadLookup } from "./thread-tokens.js";
import {
  AVAILABILITY_PATH,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
  ParentAvailability,
  isParentPoolSelf,
  readParentPool,
  type ParentPool,
} from "./parent-pool.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createHub, waitForDelay } from "./hub.js";
import { accountPoolHostContract } from "./host-contract.js";
import { OAUTH_PROXY_ROUTE } from "./oauth-proxy-policy.js";
import {
  createProxyCertificateAuthority,
  type ProxyCertificateAuthority,
} from "./proxy-ca.js";
import { PoolOperations } from "./operations.js";
import {
  accountPoolBindingReadRpcContract,
  accountPoolBypassReadRpcContract,
  accountPoolRpcContract,
  createBindingReadRpcHandlers,
  createRpcHandlers,
} from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  availabilityTtlMs?: number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  threadSweepTimeoutMs?: number;
  threadSweepLookupTimeoutMs?: number;
  threadSweepIntervalMs?: number;
  threadSweepRetryMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");
const THREAD_SWEEP_INTERVAL_MS = 15 * 60_000;
const THREAD_SWEEP_TIMEOUT_MS = 15_000;
const THREAD_SWEEP_LOOKUP_TIMEOUT_MS = 5_000;
const THREAD_SWEEP_RETRY_MS = 60_000;
const HUB_BASE_PATH = "/api/v1/plugins/account-pool/http";
const HOST_PROXY_CALL_TIMEOUT_MS = 8_000;
const HOST_PROXY_SYNC_DEBOUNCE_MS = 100;
const HOST_PROXY_RETRY_MS = 2_000;
const HOST_PROXY_RECONCILE_INTERVAL_MS = 60_000;
const HOST_PROXY_HOSTS_KEY = "artifact-proxy-hosts";
const HOST_PROXY_WARN_INTERVAL_MS = 10 * 60_000;
const ARTIFACT_PROXY_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

const CLAUDE_SETTINGS_ENV_PIN = "BB_CLAUDE_SETTINGS_ENV_PIN";
const CLAUDE_SETTINGS_ENV_PIN_PROVIDER = "BB_CLAUDE_SETTINGS_ENV_PIN_PROVIDER";
const CLAUDE_PROVIDER_ID = "claude-code";
const OUTRANKING_CLAUDE_CREDENTIALS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

const PROVIDER_ROUTING_ENV: Record<PoolProvider, readonly string[]> = {
  claude: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ],
  codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
};

interface PoolEnvEntry {
  name: string;
  value: string | { serverPath: string };
  reason: string;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    const storedConfig = z
      .record(z.string(), z.unknown())
      .parse((await bb.storage.kv.get("config")) ?? {});
    const hasRemovedSettings =
      "cacheMissDebug" in storedConfig || "cacheMissMinTokens" in storedConfig;
    delete storedConfig.cacheMissDebug;
    delete storedConfig.cacheMissMinTokens;
    let currentSettings = accountPoolConfigSchema.parse(storedConfig);
    if (hasRemovedSettings) {
      await bb.storage.kv.set("config", currentSettings);
    }
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const archiveUndoGraceKeepsCredential = (
      thread: Pick<Thread, "archivedAt" | "deletedAt" | "status">,
    ): boolean =>
      thread.deletedAt === null &&
      thread.status === "active" &&
      thread.archivedAt !== null &&
      thread.archivedAt + ARCHIVE_UNDO_GRACE_MS > now();
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const lookupThread: ThreadLookup = async (threadId, signal) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId, signal });
        if (thread.deletedAt !== null) return "gone";
        return thread.archivedAt === null ||
          archiveUndoGraceKeepsCredential(thread)
          ? "live"
          : "archived";
      } catch (error) {
        if (isThreadNotFound(error)) return "gone";
        throw error;
      }
    };
    const threadTokens = new ThreadTokenStore(
      secretDir,
      hubTokens,
      now,
      lookupThread,
      options.threadSweepLookupTimeoutMs ?? THREAD_SWEEP_LOOKUP_TIMEOUT_MS,
      (message) => bb.log.warn(message),
      bb.storage.kv,
    );
    await threadTokens.initialize(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const env = options.env ?? process.env;
    const configuredParentPool = readParentPool(env);
    const hasConfiguredParentPool = configuredParentPool !== null;
    const parentPool = (): ParentPool | null => {
      if (configuredParentPool === null) return null;
      const ownHubUrl = `${bb.server.loopbackBaseUrl.replace(/\/+$/u, "")}${HUB_BASE_PATH}`;
      return isParentPoolSelf(configuredParentPool, ownHubUrl)
        ? null
        : configuredParentPool;
    };
    const proxyingParent = (): ParentPool | null =>
      currentSettings.parentMode === "proxy" ? parentPool() : null;
    const hostProxy = bb.hosts.experimental_client({
      contract: accountPoolHostContract,
    });
    const proxyDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "proxy-ca",
    );
    let proxyAuthority: Promise<ProxyCertificateAuthority> | null = null;
    const artifactProxyAuthority = (): Promise<ProxyCertificateAuthority> => {
      proxyAuthority ??= createProxyCertificateAuthority({
        dir: proxyDir,
        now,
      }).catch((error: unknown) => {
        proxyAuthority = null;
        throw error;
      });
      return proxyAuthority;
    };
    let lastProxyWarningAt = 0;
    const warnArtifactProxy = (hostId: string, error: unknown): void => {
      const at = now();
      if (at - lastProxyWarningAt < HOST_PROXY_WARN_INTERVAL_MS) return;
      lastProxyWarningAt = at;
      bb.log.warn(
        `Account Pooler Artifact proxy is unavailable on host ${hostId}; threads there keep the plain pool credentials: ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    const sha256Hex = (value: string): string =>
      createHash("sha256").update(value).digest("hex");
    const proxyQueues = new Map<string, Promise<unknown>>();
    const proxyRetryTimers = new Set<ReturnType<typeof setTimeout>>();
    const syncArtifactProxy = (
      hostId: string,
      retry = true,
    ): Promise<{ port: number; caPath: string; noProxy: string } | null> => {
      const run = (proxyQueues.get(hostId) ?? Promise.resolve()).then(
        async () => {
          try {
            const authority = await artifactProxyAuthority();
            const leaf = await authority.leafFor(hostId);
            const tokenDigests = await threadTokens.activeTokenDigests(hostId);
            const result = await hostProxy.call(
              "ensureProxy",
              {
                caPem: await authority.caPem(),
                leafCertPem: leaf.certPem,
                leafKeyPem: leaf.keyPem,
                proxyCredentialSha256s: tokenDigests.map((digest) =>
                  sha256Hex(authority.proxyCredential(digest)),
                ),
              },
              { hostId, timeoutMs: HOST_PROXY_CALL_TIMEOUT_MS },
            );
            const known = new Set(
              z
                .array(z.string())
                .catch([])
                .parse(await bb.storage.kv.get(HOST_PROXY_HOSTS_KEY)),
            );
            if (!known.has(hostId)) {
              known.add(hostId);
              await bb.storage.kv.set(HOST_PROXY_HOSTS_KEY, [...known]);
            }
            return result;
          } catch (error) {
            warnArtifactProxy(hostId, error);
            if (retry) {
              const timer = setTimeout(() => {
                proxyRetryTimers.delete(timer);
                void syncArtifactProxy(hostId, false);
              }, HOST_PROXY_RETRY_MS);
              timer.unref();
              proxyRetryTimers.add(timer);
            }
            return null;
          }
        },
      );
      proxyQueues.set(
        hostId,
        run.catch(() => undefined),
      );
      return run;
    };
    const ensureArtifactProxy = async (
      hostId: string,
      token: string,
    ): Promise<{
      port: number;
      caPath: string;
      noProxy: string;
      credential: string;
    } | null> => {
      const result = await syncArtifactProxy(hostId);
      if (result === null) return null;
      const authority = await artifactProxyAuthority();
      return {
        ...result,
        credential: authority.proxyCredential(sha256Hex(token)),
      };
    };
    const reconcileArtifactProxies = async (): Promise<void> => {
      const hosts = z
        .array(z.string())
        .catch([])
        .parse(await bb.storage.kv.get(HOST_PROXY_HOSTS_KEY));
      await Promise.all(hosts.map((hostId) => syncArtifactProxy(hostId)));
    };
    hostProxy.experimental_onWorkerExit(({ hostId }) => {
      void syncArtifactProxy(hostId);
    });
    let proxySyncTimer: ReturnType<typeof setTimeout> | null = null;
    threadTokens.onCredentialsChanged(() => {
      if (proxySyncTimer !== null) return;
      proxySyncTimer = setTimeout(() => {
        proxySyncTimer = null;
        void reconcileArtifactProxies().catch(() => undefined);
      }, HOST_PROXY_SYNC_DEBOUNCE_MS);
      proxySyncTimer.unref();
    });
    const reconcileTimer = setInterval(() => {
      void reconcileArtifactProxies().catch(() => undefined);
    }, HOST_PROXY_RECONCILE_INTERVAL_MS);
    reconcileTimer.unref();
    bb.onDispose(() => {
      clearInterval(reconcileTimer);
      if (proxySyncTimer !== null) clearTimeout(proxySyncTimer);
      for (const timer of proxyRetryTimers) clearTimeout(timer);
    });
    void reconcileArtifactProxies().catch(() => undefined);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      threadTokens,
      routing,
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      getParentRoute: proxyingParent,
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      onOAuthRelay: ({ method, route, upstream, durationMs }) =>
        bb.log.info(
          `Account Pooler relayed ${method} ${route} -> ${
            upstream.kind === "status"
              ? `upstream ${upstream.status}`
              : `upstream=error ${upstream.errorClass}`
          } in ${durationMs}ms`,
        ),
      onOAuthRefresh: (provider, accountId, outcome, detail) => {
        const message = `Account Pooler ${provider} account ${accountId} OAuth refresh ${outcome}: ${detail}`;
        if (outcome === "succeeded") bb.log.info(message);
        else bb.log.warn(message);
      },
    });
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const availability =
      configuredParentPool === null
        ? null
        : new ParentAvailability({
            parent: configuredParentPool,
            fetch: upstreamFetch ?? fetch,
            now,
            ...(options.availabilityTtlMs === undefined
              ? {}
              : { ttlMs: options.availabilityTtlMs }),
            onError: (error) =>
              bb.log.warn(
                `Account Pooler could not read parent availability: ${error instanceof Error ? error.message : String(error)}.`,
              ),
          });
    const parentStatus = async (): Promise<PoolStatus["parent"]> => {
      const parent = parentPool();
      return parent === null || availability === null
        ? null
        : {
            baseUrl: parent.baseUrl,
            mode: currentSettings.parentMode,
            availability: await availability.get(),
          };
    };
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates(hostId === null ? {} : { hostId }))
          .providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      async (accountId) => {
        await hub.refreshUsage(accountId, true);
      },
      parentStatus,
      async (threadId) => {
        const [thread, queue] = await Promise.all([
          bb.sdk.threads.get({ threadId }),
          bb.sdk.threads.queuedMessages.list({ threadId }),
        ]);
        return {
          providerId: thread.providerId,
          status: thread.status,
          queued: queue.length > 0,
        };
      },
    );
    bb.experimental_hooks.on(
      "experimental_thread.configure",
      async ({ thread, data }) => {
        const selection = draftSelectionSchema.parse(data);
        if (
          thread.providerId !==
          (selection.provider === "claude" ? "claude-code" : "codex")
        ) {
          throw new Error(
            "The selected subscription belongs to another provider.",
          );
        }
        await operations.initializeSelection(
          thread.id,
          selection.provider,
          selection.accountId,
        );
        return null;
      },
    );
    bb.events.on("thread.archived", async ({ thread }) => {
      if (!archiveUndoGraceKeepsCredential(thread))
        await threadTokens.suspendThread(thread.id);
    });
    bb.events.on("thread.unarchived", async ({ thread }) => {
      await threadTokens.unarchiveThread(thread.id);
    });
    bb.events.on("thread.deleted", async ({ thread }) => {
      await Promise.all([
        threadTokens.removeThread(thread.id),
        routing.removeThread(thread.id),
      ]);
    });
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
      reauthorizeAccount: (accountId, authenticated, label) =>
        operations.reauthorizeClaude(accountId, authenticated, label),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
      reauthorizeAccount: (accountId, authenticated) =>
        operations.reauthorizeCodex(accountId, authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    const routedProviderSchema = z.enum(["claude", "codex"]);
    const failedRequestSchema = z.object({
      requestId: z.string(),
      execution: z.object({ model: z.string() }),
    });
    const retryAvailability = async (input: {
      threadId: string;
      requestId: string;
    }): Promise<RetryAvailability> => {
      const provider = routedProviderSchema.safeParse(
        await bb.storage.kv.get(`retry-route:${input.threadId}`),
      );
      if (!provider.success) return { kind: "not-routed" };
      const events = await bb.sdk.threads.events.list({
        threadId: input.threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const request = failedRequestSchema.safeParse(events[0]?.data);
      if (!request.success || request.data.requestId !== input.requestId)
        return { kind: "unavailable", reason: "source-unavailable" };
      return hub.retryAvailability(
        provider.data,
        modelFamily(request.data.execution.model),
      );
    };
    bb.rpc.register(
      retryAvailabilityContract,
      { [retryAvailabilityMethod]: retryAvailability },
      {
        experimental_discoverable: true,
        experimental_description:
          "Account Pooler retry availability for routed failed turns.",
      },
    );
    registerUsageSource(bb, hub, (provider) =>
      operations.isRoutingEnabled(provider),
    );
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config),
    );
    bb.rpc.register(
      accountPoolBypassReadRpcContract,
      { "bypass.get": ({ threadId }) => operations.getBypass(threadId) },
      { experimental_discoverable: true },
    );
    bb.rpc.register(
      accountPoolBindingReadRpcContract,
      createBindingReadRpcHandlers(operations),
      { experimental_discoverable: true },
    );
    registerPoolCli(bb, operations, login, codexLogin, config);
    const canServe = async (provider: PoolProvider): Promise<boolean> => {
      if (!(await operations.isRoutingEnabled(provider))) return false;
      if (proxyingParent() !== null && availability !== null) {
        return (await availability.get())[provider];
      }
      return operations.hasUsableEnabledAccount(provider);
    };
    const markerEntries = (token: string): PoolEnvEntry[] => [
      {
        name: PARENT_URL_ENV,
        value: { serverPath: HUB_BASE_PATH },
        reason: "Account Pooler hub for nested bb servers on this machine",
      },
      {
        name: PARENT_TOKEN_ENV,
        value: token,
        reason:
          "Account Pooler token scoped to this thread for nested bb servers it launches",
      },
    ];
    const neutralized = (provider: PoolProvider): PoolEnvEntry[] =>
      PROVIDER_ROUTING_ENV[provider].map((name) => ({
        name,
        value: "",
        reason:
          "Account Pooler is isolated from the parent bb server's pool on this instance",
      }));
    const revokeIfArchived = async (threadId: string): Promise<boolean> =>
      !(await threadTokens.settleThread(threadId));
    const sweepThreadCredentialsOnce = async (
      serviceSignal: AbortSignal,
    ): Promise<boolean> => {
      try {
        const { checked, revoked, failed } = await threadTokens.sweepThreads(
          lookupThread,
          {
            signal: AbortSignal.any([
              serviceSignal,
              AbortSignal.timeout(
                options.threadSweepTimeoutMs ?? THREAD_SWEEP_TIMEOUT_MS,
              ),
            ]),
            lookupTimeoutMs:
              options.threadSweepLookupTimeoutMs ??
              THREAD_SWEEP_LOOKUP_TIMEOUT_MS,
          },
        );
        if (revoked > 0 || failed > 0) {
          bb.log.warn(
            `Account Pooler thread credential sweep checked ${checked} threads, revoked ${revoked}, and could not look up ${failed}.`,
          );
        }
        return failed === 0;
      } catch {
        bb.log.warn("Account Pooler thread credential sweep failed.");
        return false;
      }
    };
    const sweepThreadCredentialsPeriodically = async (
      signal: AbortSignal,
      startupComplete: boolean,
    ): Promise<void> => {
      let complete = startupComplete;
      while (!signal.aborted) {
        await waitForDelay(
          complete
            ? (options.threadSweepIntervalMs ?? THREAD_SWEEP_INTERVAL_MS)
            : (options.threadSweepRetryMs ?? THREAD_SWEEP_RETRY_MS),
          signal,
        );
        if (!signal.aborted)
          complete = await sweepThreadCredentialsOnce(signal);
      }
    };
    const checkArchived = async (
      threadId: string,
    ): Promise<
      | { status: "archived" }
      | { status: "active" }
      | { status: "unknown"; error: unknown }
    > => {
      try {
        return (await revokeIfArchived(threadId))
          ? { status: "archived" }
          : { status: "active" };
      } catch (error) {
        return { status: "unknown", error };
      }
    };
    const contributeFor =
      (
        provider: PoolProvider,
        serving: (
          token: string,
          scope?: "thread" | "machine",
          context?: ExperimentalPluginProviderEnvContext,
        ) => Promise<PoolEnvEntry[]>,
      ) =>
      async (context: ExperimentalPluginProviderEnvContext) => {
        const lifetime =
          context.experimental_runtimeKind === "native" ? "process" : "durable";
        const unrouted = () =>
          hasConfiguredParentPool ? neutralized(provider) : [];
        if (context.threadId === null) {
          if (!(await canServe(provider))) return unrouted();
          const hostToken = await hubTokens.forHost(context.hostId);
          const token = await threadTokens.forCatalog(
            context.hostId,
            provider,
            hostToken,
          );
          return serving(token, "machine");
        }
        const archive = await checkArchived(context.threadId);
        if (archive.status === "archived") return unrouted();
        const bypassed = await routing.isBypassed(context.threadId);
        const selectedAccountId = await routing.selectedAccount(
          context.threadId,
          provider,
        );
        const accountId = proxyingParent() === null ? selectedAccountId : null;
        const canRoute =
          !bypassed &&
          (accountId === null
            ? await canServe(provider)
            : await operations.isRoutingEnabled(provider));
        if (canRoute) {
          if (archive.status === "unknown") throw archive.error;
          await bb.storage.kv.set(`retry-route:${context.threadId}`, provider);
          const hostToken = await hubTokens.forHost(context.hostId);
          const token = await threadTokens.forThread(
            {
              threadId: context.threadId,
              hostId: context.hostId,
              provider,
              accountId,
            },
            hostToken,
            lifetime,
          );
          const nestedToken = await threadTokens.forNested(
            { threadId: context.threadId, hostId: context.hostId },
            hostToken,
            lifetime,
          );
          if (await revokeIfArchived(context.threadId)) return unrouted();
          if (provider === "claude") {
            await routing.recordRouted(context.threadId, context.hostId);
          }
          return [
            ...(await serving(token, "thread", context)),
            ...markerEntries(nestedToken),
          ];
        }
        await bb.storage.kv.delete(`retry-route:${context.threadId}`);
        return unrouted();
      };
    const subscriptionCacheEntries = async (): Promise<PoolEnvEntry[]> =>
      proxyingParent() === null &&
      (await operations.routesOnlyApiKeys("claude"))
        ? []
        : [
            {
              name: "ENABLE_PROMPT_CACHING_1H",
              value: "1",
              reason:
                "Claude Code uses a 5-minute prompt cache behind a custom base URL; subscription accounts get the 1-hour cache Claude Code uses for a direct subscription login",
            },
          ];
    const isServingHealthily = async (
      provider: PoolProvider,
    ): Promise<boolean> => {
      if (proxyingParent() !== null && availability !== null) {
        return canServe(provider);
      }
      return operations.hasReadyAccount(provider);
    };
    const proxiedHealth = async (provider: PoolProvider) =>
      (await isServingHealthily(provider))
        ? {
            label: "Proxied",
            statusMessage:
              proxyingParent() === null
                ? "Credentials are provided by the Account Pooler hub."
                : "Credentials are proxied to the parent bb server's Account Pooler.",
          }
        : null;
    bb.providers.experimental_contributeEnv(
      CLAUDE_PROVIDER_ID,
      contributeFor("claude", async (token, scope, context) => {
        const proxy =
          context === undefined ||
          context.threadId === null ||
          proxyingParent() !== null ||
          (await operations.routesOnlyApiKeys("claude"))
            ? null
            : await ensureArtifactProxy(context.hostId, token);
        const entries: PoolEnvEntry[] = [
          {
            name: "ANTHROPIC_BASE_URL",
            value: { serverPath: HUB_BASE_PATH },
            reason: "Routed through the Account Pooler hub",
          },
          proxy === null
            ? {
                name: "ANTHROPIC_AUTH_TOKEN",
                value: token,
                reason: `Account Pooler token scoped to this ${scope ?? "thread"}`,
              }
            : {
                name: "CLAUDE_CODE_OAUTH_TOKEN",
                value: token,
                reason: `Account Pooler token scoped to this ${scope ?? "thread"}; it puts Claude Code in claude.ai account mode so Artifacts work, and the hub swaps it for the selected account's credential`,
              },
          {
            name: "ENABLE_TOOL_SEARCH",
            value: "true",
            reason:
              "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
          },
          {
            name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
            value: "1",
            reason:
              "Claude Code limits Opus to a 200k context window behind a custom base URL; the hub forwards to Anthropic's API",
          },
          ...(await subscriptionCacheEntries()),
          ...(proxy === null
            ? hasConfiguredParentPool
              ? ARTIFACT_PROXY_ENV.map((name) => ({
                  name,
                  value: "",
                  reason:
                    "This bb server does not provide the Account Pooler Artifact proxy, so the parent thread's proxy settings are cleared",
                }))
              : []
            : [
                {
                  name: "HTTPS_PROXY",
                  value: `http://pool:${proxy.credential}@127.0.0.1:${proxy.port}`,
                  reason:
                    "Host-local Account Pooler proxy: it relays Claude Code's Artifact traffic to the hub and tunnels everything else directly",
                },
                {
                  name: "NO_PROXY",
                  value: proxy.noProxy,
                  reason:
                    "Keeps the hub and loopback traffic, plus any NO_PROXY already set on the host, off the Account Pooler proxy",
                },
                {
                  name: "NODE_EXTRA_CA_CERTS",
                  value: proxy.caPath,
                  reason:
                    "Trusts the Account Pooler proxy's certificate authority, which is limited to api.anthropic.com",
                },
                {
                  name: "CLAUDE_CODE_ARTIFACT",
                  value: "1",
                  reason:
                    "Claude Code leaves Artifacts off in SDK sessions unless this is set",
                },
                ...OUTRANKING_CLAUDE_CREDENTIALS.map((name) => ({
                  name,
                  value: "",
                  reason:
                    "Claude Code prefers this credential over the Account Pooler token, so a host value is cleared",
                })),
              ]),
        ];
        return [
          ...entries,
          {
            name: CLAUDE_SETTINGS_ENV_PIN,
            value: entries.map((entry) => entry.name).join(","),
            reason:
              "Names the variables Claude Code must also take from its highest-precedence settings layer, because a host settings.json env block would otherwise replace the Account Pooler routing",
          },
          {
            name: CLAUDE_SETTINGS_ENV_PIN_PROVIDER,
            value: CLAUDE_PROVIDER_ID,
            reason:
              "Names the provider whose launches must apply that pin, so a native launch of another provider that inherits the marker ignores it",
          },
        ];
      }),
    );
    bb.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    bb.providers.experimental_contributeEnv(
      "codex",
      contributeFor("codex", async (token, scope) => [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${HUB_BASE_PATH}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: `Account Pooler token scoped to this ${scope ?? "thread"}`,
        },
      ]),
    );
    bb.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "claude", route),
        { auth: "none" },
      );
    }
    bb.http.route(
      "POST",
      OAUTH_PROXY_ROUTE,
      (context) => hub.handleOAuthProxy(context.req.raw),
      { auth: "none" },
    );
    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex", route),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex", "/v1/models"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      AVAILABILITY_PATH,
      async (context) => {
        if ((await hub.authenticateNested(context.req.raw)) === null) {
          return new Response(null, { status: 401 });
        }
        return Response.json(
          poolAvailabilitySchema.parse({
            claude: await canServe("claude"),
            codex: await canServe("codex"),
          }),
        );
      },
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      "/retry-availability",
      async (context) => {
        const query = z
          .object({ provider: routedProviderSchema, family: modelFamilySchema })
          .safeParse(
            Object.fromEntries(new URL(context.req.raw.url).searchParams),
          );
        const hostId = query.success
          ? await hub.authenticateProvider(context.req.raw, query.data.provider)
          : await hub.authenticateNested(context.req.raw);
        if (hostId === null) return new Response(null, { status: 401 });
        if (!query.success) return new Response(null, { status: 400 });
        return Response.json(
          await hub.retryAvailability(query.data.provider, query.data.family),
        );
      },
      { auth: "none" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: async (signal) => {
        const startupComplete = await sweepThreadCredentialsOnce(signal);
        await Promise.all([
          hub.start(signal),
          sweepThreadCredentialsPeriodically(signal, startupComplete),
        ]);
      },
    });
  };
}

function isThreadNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404 &&
    "code" in error &&
    error.code === "thread_not_found"
  );
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
