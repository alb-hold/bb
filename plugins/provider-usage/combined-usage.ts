import { hasReportedUsage } from "./usage-feedback.js";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

const combinedLocationId = "combined";

function isSource(machine: UsageMachine): boolean {
  return machine.id.startsWith("source:");
}

function shouldKeepHostClaude(
  provider: UsageProvider,
  pooledClaude: UsageProvider[],
): boolean {
  if (pooledClaude.length === 0) return true;
  if (provider.accountKey == null) return false;
  if (pooledClaude.some((pooled) => pooled.accountKey == null)) return false;
  return !pooledClaude.some(
    (pooled) =>
      pooled.providerId === provider.providerId &&
      pooled.accountKey === provider.accountKey,
  );
}

interface UsageRefreshTarget {
  machine: UsageMachine;
  providerIds: string[];
}

export function combinedUsageSelection(machines: UsageMachine[]): {
  providers: UsageProvider[];
  refreshTargets: UsageRefreshTarget[];
} {
  const sourceClaude = machines
    .filter(isSource)
    .flatMap((machine) =>
      machine.providers
        .filter((provider) => provider.providerId === "claude-code")
        .map((provider) => ({ machine, provider })),
    );
  const seenPooled = new Set<string>();
  const pooledClaude = sourceClaude.filter(({ provider }) => {
    if (provider.accountKey == null) return true;
    const identity = JSON.stringify([provider.providerId, provider.accountKey]);
    if (seenPooled.has(identity)) return false;
    seenPooled.add(identity);
    return true;
  });
  const host = machines.find((machine) => !isSource(machine));
  const hasPooledClaude = pooledClaude.length > 0;
  const pooledProviders = pooledClaude.map(({ provider }) => provider);
  const hostProviders =
    host?.providers.filter(
      (provider) =>
        provider.providerId !== "claude-code" ||
        !hasPooledClaude ||
        shouldKeepHostClaude(provider, pooledProviders),
    ) ?? [];
  const providers = hasPooledClaude
    ? [...pooledProviders, ...hostProviders]
    : hostProviders;
  const targetsByMachine = new Map<UsageMachine, Set<string>>();
  const addTarget = (machine: UsageMachine, providerId: string) => {
    const providerIds = targetsByMachine.get(machine) ?? new Set<string>();
    providerIds.add(providerId);
    targetsByMachine.set(machine, providerIds);
  };
  if (hasPooledClaude) {
    for (const { machine } of pooledClaude) addTarget(machine, "claude-code");
    for (const provider of hostProviders) {
      if (host !== undefined) addTarget(host, provider.providerId);
    }
  } else if (host !== undefined) {
    for (const provider of hostProviders) addTarget(host, provider.providerId);
  }
  return {
    providers,
    refreshTargets: [...targetsByMachine].map(([machine, providerIds]) => ({
      machine,
      providerIds: [...providerIds],
    })),
  };
}

export function combinedUsageMachine(
  machines: UsageMachine[],
  displayName = "Combined",
): UsageMachine | null {
  const { providers } = combinedUsageSelection(machines);
  const sourceClaude = machines.filter(
    (machine) =>
      isSource(machine) &&
      machine.providers.some(
        (provider) => provider.providerId === "claude-code",
      ),
  );
  const host = machines.find((machine) => !isSource(machine));
  const hasPooledClaude = sourceClaude.length > 0;
  const sourceError = [...sourceClaude, host].some(
    (machine) => machine !== undefined && machine.error !== null,
  );
  if (host === undefined && sourceClaude.length === 0) return null;
  return {
    id: combinedLocationId,
    displayName,
    status: hasPooledClaude ? "connected" : (host?.status ?? "connected"),
    providers,
    error:
      sourceError && !hasReportedUsage(providers)
        ? "Usage could not be refreshed."
        : null,
  };
}

export function usageTargetsToRefresh(
  machines: UsageMachine[],
  selectedId: string | null,
): UsageRefreshTarget[] {
  if (selectedId !== null && selectedId !== combinedLocationId) {
    const selected = machines.find((machine) => machine.id === selectedId);
    return selected === undefined
      ? []
      : [
          {
            machine: selected,
            providerIds: [
              ...new Set(
                selected.providers.map((provider) => provider.providerId),
              ),
            ],
          },
        ];
  }
  return combinedUsageSelection(machines).refreshTargets;
}
