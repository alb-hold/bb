import type { SystemProviderState } from "@bb/server-contract";

export function resolveReadyProviderId(
  providerStates: readonly SystemProviderState[],
  preferredProviderId?: string | null,
): string | undefined {
  const readyInOrder = providerStates
    .filter((provider) => provider.status === "ready")
    .map((provider) => provider.providerId);
  if (readyInOrder.length === 0) {
    return undefined;
  }
  if (
    preferredProviderId !== undefined &&
    preferredProviderId !== null &&
    preferredProviderId.length > 0 &&
    readyInOrder.includes(preferredProviderId)
  ) {
    return preferredProviderId;
  }
  return readyInOrder[0];
}
