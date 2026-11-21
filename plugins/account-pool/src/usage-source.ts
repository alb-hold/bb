import { type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AccountSummary } from "./contracts.js";
import type { AccountPoolHub } from "./hub.js";
import { foldSubscriptions } from "./subscriptions.js";
import {
  usageSourceRpcContract,
  usageListMethod,
  usageFetchMethod,
  type UsageResource,
} from "./usage-contract.js";

export function usageWindowLabel(
  minutes: number | null,
  fallback: string,
): string {
  if (minutes === 300) return "Five-hour limit";
  if (minutes === 1_440) return "Daily limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes === null) return fallback;
  return minutes % 1_440 === 0
    ? `${minutes / 1_440} day limit`
    : `${minutes / 60} hour limit`;
}

export function accountUsageWindows(
  account: Pick<
    AccountSummary,
    | "limitWindows"
    | "fiveHourUtilization"
    | "fiveHourResetAt"
    | "sevenDayUtilization"
    | "sevenDayResetAt"
  >,
) {
  if (account.limitWindows.length > 0) {
    return account.limitWindows.map((window) => ({
      id: window.slot,
      label: usageWindowLabel(window.windowMinutes, window.slot),
      utilization: window.utilization,
      resetAt: window.resetAt,
    }));
  }
  return [
    {
      id: "five-hour",
      label: "Five-hour limit",
      utilization: account.fiveHourUtilization ?? null,
      resetAt: account.fiveHourResetAt ?? null,
    },
    {
      id: "weekly",
      label: "Weekly limit",
      utilization: account.sevenDayUtilization ?? null,
      resetAt: account.sevenDayResetAt ?? null,
    },
  ];
}

export function usagePlan(
  account: Pick<AccountSummary, "subscriptionType" | "rateLimitTier">,
): { id: string; label: string } | null {
  const tier = account.rateLimitTier ?? "";
  if (/max_20x/u.test(tier)) return { id: "ultra", label: "Ultra" };
  if (/max_\d+x/u.test(tier)) return { id: "max", label: "Max" };
  const subscription = account.subscriptionType;
  return subscription
    ? {
        id: subscription.toLowerCase(),
        label: subscription.charAt(0).toUpperCase() + subscription.slice(1),
      }
    : null;
}
export { displayPlanLabel as usagePlanLabel } from "./display.js";
import { displayPlanLabel, modelWeeklyRows } from "./display.js";

function usageProviderId(provider: AccountSummary["provider"]): string {
  return provider === "claude"
    ? "claude-code"
    : provider === "gemini"
      ? "acp-antigravity-acp"
      : "codex";
}

function accountKey(account: AccountSummary): string | null {
  if (account.provider === "gemini")
    return account.email ? `google:gemini:${account.email.toLowerCase()}` : null;
  return account.provider === "codex"
    ? account.codexAccountId
      ? `openai:chatgpt:${account.codexAccountId}`
      : null
    : account.accountUuid
      ? `anthropic:account:${account.accountUuid}`
      : null;
}

export function registerUsageSource(
  bb: BbPluginApi,
  hub: AccountPoolHub,
  isRoutingEnabled: (provider: AccountSummary["provider"]) => Promise<boolean>,
) {
  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const status = await hub.status();
        const routed = await Promise.all(
          status.accounts.map(async (account) => ({
            account,
            enabled: await isRoutingEnabled(account.provider),
          })),
        );
        const accounts = foldSubscriptions(
          routed
            .filter(({ account, enabled }) => enabled && account.enabled)
            .map(({ account }) => account)
            .sort((left, right) => left.priority - right.priority),
        );
        return {
          ...(accounts.length > 0 ? { label: "Account Pooler" } : {}),
          resources: accounts.map((account) => ({
            id: account.id,
            accountKey: accountKey(account),
            providerId: usageProviderId(account.provider),
            label: account.label,
            scope: { kind: "shared" as const },
            accountPool: {
              active: account.active,
              enabled: account.enabled,
              status: account.status,
              heldUntil: account.heldUntil,
              error: account.error,
              extraUsage: account.extraUsage?.status ?? null,
            },
          })),
        };
      },
      async [usageFetchMethod]({ resourceId, refresh }) {
        const controller = new AbortController();
        const { signal } = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Account usage read timed out. Try again.");
            controller.abort(error);
            reject(error);
          }, 30_000);
        });
        const getAccount = async () => {
          const account = (await hub.status(signal)).accounts.find(
            (account) => account.id === resourceId,
          );
          if (
            account === undefined ||
            (account.kind !== "oauth" &&
              (!account.enabled || !(await isRoutingEnabled(account.provider))))
          )
            throw new Error("Usage resource no longer exists.");
          return account;
        };
        const read = async () => {
          await getAccount();
          signal.throwIfAborted();
          if (!(await hub.refreshUsage(resourceId, refresh, signal)) && refresh)
            throw new Error("Could not refresh account usage. Try again.");
          signal.throwIfAborted();
          const accounts = [await getAccount()];
          signal.throwIfAborted();
          const display = await hub.display(signal);
          signal.throwIfAborted();
          const resources: UsageResource[] = accounts.map((account) => {
            const windows: Extract<
              UsageResource["usage"],
              { status: "ok" }
            >["windows"] = [];
            let expiredWindows = 0;
            const add = (
              id: string,
              label: string,
              utilization: number | null,
              reset: number | null,
              model: string | null,
            ) => {
              if (utilization === null) return;
              if (reset !== null && reset <= Date.now()) {
                expiredWindows += 1;
                return;
              }
              windows.push({
                kind:
                  label === "Five-hour limit"
                    ? "five-hour"
                    : label === "Daily limit"
                      ? "daily"
                      : label.startsWith("Weekly")
                        ? "weekly"
                        : "custom",
                id,
                label,
                usedPercent: Math.round(utilization * 100),
                resetsAt: reset === null ? null : new Date(reset).toISOString(),
                model,
                cost: null,
              });
            };
            for (const window of accountUsageWindows(account)) {
              add(window.id, window.label, window.utilization, window.resetAt, null);
            }
            for (const { name, quota } of modelWeeklyRows(
              account,
              display.weekly[account.id],
            )) {
              add(
                `weekly:${name}`,
                `Weekly · ${name}`,
                quota.utilization,
                quota.resetAt,
                name,
              );
            }
            const accountFields = {
              plan: account.subscriptionType
                ? {
                    id: account.subscriptionType.toLowerCase(),
                    multiplier:
                      Number(
                        account.rateLimitTier?.match(/max_(\d+)x/u)?.[1],
                      ) || null,
                  }
                : null,
              accountEmail: account.email,
              planLabel: displayPlanLabel(
                account,
                display.plans[account.id] ?? null,
              ),
            };
            const error =
              (account.error === null
                ? null
                : "Usage could not be collected for this account. Try refreshing usage.") ??
              (account.observedAt === null
                ? "Usage has not been observed for this account."
                : expiredWindows > 0 && windows.length === 0
                  ? "Usage data is stale. Refresh usage."
                  : null);
            return {
              id: account.id,
              accountKey: accountKey(account),
              providerId: usageProviderId(account.provider),
              label: account.label,
              scope: { kind: "shared" },
              observedAt: account.observedAt,
              usage:
                error === null
                  ? { status: "ok", ...accountFields, windows }
                  : { status: "error", ...accountFields, message: error },
            };
          });
          const resource = resources[0]!;
          return {
            accountKey: resource.accountKey,
            observedAt: resource.observedAt,
            usage: resource.usage,
          };
        };
        try {
          return await Promise.race([read(), timedOut]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Usage windows for enabled, routed Account Pooler accounts. API-key accounts report quota observed from provider responses.",
    },
  );
}
