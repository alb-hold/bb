import { describe, expect, it } from "vitest";
import {
  combinedUsageMachine,
  combinedUsageSelection,
} from "./combined-usage.js";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";

function account(
  providerId: string,
  id: string,
  accountKey: string | null,
): UsageProvider {
  return {
    id,
    providerId,
    accountKey,
    accountLabel: id,
    displayName: providerId,
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: null,
  };
}

function machine(id: string, providers: UsageProvider[]): UsageMachine {
  return {
    id,
    displayName: id,
    status: "connected",
    providers,
    error: null,
  };
}

const pooledClaude = account("claude-code", "pool:claude", "anthropic:a");
const pooledAntigravity = account(
  "acp-antigravity-acp",
  "pool:antigravity",
  "google:gemini:a@example.com",
);

describe("combined usage with the account pooler", () => {
  it("lists pooled Antigravity next to pooled Claude and refreshes its source", () => {
    const source = machine("source:account-pool", [
      pooledClaude,
      pooledAntigravity,
    ]);
    const host = machine("host-1", [account("codex", "host:codex", null)]);
    const combined = combinedUsageMachine([host, source]);
    expect(combined?.providers.map((provider) => provider.id)).toEqual([
      "pool:claude",
      "pool:antigravity",
      "host:codex",
    ]);
    const { refreshTargets } = combinedUsageSelection([host, source]);
    expect(
      refreshTargets.find((target) => target.machine === source)?.providerIds,
    ).toEqual(["claude-code", "acp-antigravity-acp"]);
  });

  it("lists pooled Antigravity and refreshes its source when the pool has no Claude", () => {
    const source = machine("source:account-pool", [pooledAntigravity]);
    const host = machine("host-1", [account("codex", "host:codex", null)]);
    const combined = combinedUsageMachine([host, source]);
    expect(combined?.providers.map((provider) => provider.id)).toEqual([
      "pool:antigravity",
      "host:codex",
    ]);
    expect(
      combinedUsageSelection([host, source]).refreshTargets.find(
        (target) => target.machine === source,
      )?.providerIds,
    ).toEqual(["acp-antigravity-acp"]);
  });

  it("combines an Antigravity-only pool even without a host machine", () => {
    const source = machine("source:account-pool", [pooledAntigravity]);
    expect(
      combinedUsageMachine([source])?.providers.map((provider) => provider.id),
    ).toEqual(["pool:antigravity"]);
  });

  it("keeps pooled Codex out of the combined view", () => {
    const source = machine("source:account-pool", [
      pooledClaude,
      account("codex", "pool:codex", "openai:chatgpt:a"),
    ]);
    const host = machine("host-1", [account("codex", "host:codex", null)]);
    expect(
      combinedUsageMachine([host, source])?.providers.map(
        (provider) => provider.id,
      ),
    ).toEqual(["pool:claude", "host:codex"]);
  });

  it("drops a host Antigravity copy of the same pooled account only", () => {
    const source = machine("source:account-pool", [
      pooledClaude,
      pooledAntigravity,
    ]);
    const host = machine("host-1", [
      account(
        "acp-antigravity-acp",
        "host:same",
        "google:gemini:a@example.com",
      ),
      account(
        "acp-antigravity-acp",
        "host:other",
        "google:gemini:b@example.com",
      ),
    ]);
    const combined = combinedUsageMachine([host, source]);
    expect(combined?.providers.map((provider) => provider.id)).toEqual([
      "pool:claude",
      "pool:antigravity",
      "host:other",
    ]);
  });
});
