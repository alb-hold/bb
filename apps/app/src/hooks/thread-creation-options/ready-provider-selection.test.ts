import type { SystemProviderState } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { resolveReadyProviderId } from "./ready-provider-selection";

function providerState(
  providerId: string,
  status: SystemProviderState["status"],
): SystemProviderState {
  return {
    providerId,
    displayName: providerId,
    status,
    statusMessage: null,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
    localLoginCommand: null,
    internal_DO_NOT_USE_guidedSignIn: false,
    internal_DO_NOT_USE_setupGuidePlanLabel: null,
  };
}

describe("resolveReadyProviderId", () => {
  const states = [
    providerState("pi", "ready"),
    providerState("codex", "ready"),
    providerState("claude-code", "unauthenticated"),
  ];

  it("prefers the configured default when it is ready", () => {
    expect(resolveReadyProviderId(states, "codex")).toBe("codex");
  });

  it("falls back to the first ready provider in list order", () => {
    expect(resolveReadyProviderId(states, null)).toBe("pi");
  });

  it("returns undefined when no provider is ready", () => {
    expect(
      resolveReadyProviderId([providerState("pi", "unauthenticated")], "codex"),
    ).toBeUndefined();
  });
});
