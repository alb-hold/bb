import type { UsageMeasurement } from "./usage-source-contract.js";
import { internal_DO_NOT_USE_claudeLocalPlanLabel as claudeLocalPlanLabel } from "@get-bb/plugin-sdk";

export function normalizeUsageMeasurement(
  measurement: UsageMeasurement,
  providerId: string,
): UsageMeasurement {
  if (measurement.usage.status !== "ok") return measurement;
  const usage = measurement.usage;
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    max: "Max",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    education: "Education",
    edu: "Education",
  };
  const plan = usage.plan;
  const claudeMax =
    providerId === "claude-code" &&
    /max/iu.test(`${plan?.id ?? ""} ${usage.planLabel ?? ""}`);
  const planLabel = claudeMax
    ? claudeLocalPlanLabel({
        subscriptionType: "max",
        rateLimitTier:
          plan?.multiplier == null ? null : `max_${plan.multiplier}x`,
      })
    : usage.planLabel !== null &&
        /^max$/iu.test(usage.planLabel) &&
        plan?.multiplier != null
      ? `Max (${plan.multiplier}x)`
      : usage.planLabel;
  const planName = claudeMax
    ? "Claude subscription"
    : plan
      ? labels[plan.id]
      : undefined;
  const windowLabels = {
    "five-hour": "Five-hour limit",
    daily: "Daily limit",
    weekly: "Weekly limit",
    custom: "",
  };
  return {
    ...measurement,
    usage: {
      ...usage,
      planLabel:
        planLabel ??
        (planName
          ? `${planName}${plan?.multiplier == null || claudeMax ? "" : ` (${plan.multiplier}x)`}`
          : providerId === "claude-code"
            ? "Claude subscription"
            : null),
      windows: usage.windows.map((window) => ({
        ...window,
        label:
          window.kind && window.kind !== "custom"
            ? window.model
              ? `${window.kind === "weekly" ? "Weekly" : windowLabels[window.kind]} · ${window.model.charAt(0).toUpperCase() + window.model.slice(1)}`
              : windowLabels[window.kind]
            : window.label,
      })),
    },
  };
}

type Identity = {
  providerId: string;
  accountKey?: string | null;
  scope: { kind: "shared" | "host" };
};

export function selectUsageResources<T>(
  resources: readonly T[],
  identify: (resource: T) => Identity,
): T[] {
  const result: T[] = [];
  const known = new Map<string, number>();
  for (const resource of resources) {
    const identity = identify(resource);
    if (!identity.accountKey) {
      result.push(resource);
      continue;
    }
    const key = JSON.stringify([identity.providerId, identity.accountKey]);
    const index = known.get(key);
    if (index === undefined) {
      known.set(key, result.length);
      result.push(resource);
    } else if (
      identity.scope.kind === "shared" &&
      identify(result[index]!).scope.kind !== "shared"
    )
      result[index] = resource;
  }
  return result;
}
