import type { ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import { claudeAiStatusFromHealth } from "./claude-status.js";

function health(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  statusMessage: string | null = null,
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage,
      accountEmail: null,
      planLabel: null,
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: true,
      loginCommand: "claude auth login",
    },
  } as ProviderHealthResult;
}

describe("claudeAiStatusFromHealth", () => {
  it.each(["ready", "expired"] as const)(
    "is ready when the sign-in is %s, since the CLI renews it",
    (status) => {
      expect(claudeAiStatusFromHealth(health(status))).toEqual({ ready: true });
    },
  );

  it("asks for a sign-in when signed out", () => {
    expect(claudeAiStatusFromHealth(health("unauthenticated"))).toEqual({
      ready: false,
      message: "Run `claude auth login` on the primary machine",
    });
  });

  it("keeps the renewal message when the sign-in was rejected", () => {
    expect(
      claudeAiStatusFromHealth(health("unauthenticated", "Sign in again")),
    ).toEqual({ ready: false, message: "Sign in again" });
  });

  it("asks for an install when the CLI is missing", () => {
    expect(claudeAiStatusFromHealth(health("not_installed"))).toEqual({
      ready: false,
      message: "Install Claude Code on the primary machine",
    });
  });

  it("reports an unreadable sign-in as not ready", () => {
    expect(
      claudeAiStatusFromHealth(health("unknown", "Keychain locked")),
    ).toEqual({ ready: false, message: "Keychain locked" });
  });
});
