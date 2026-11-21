import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  files: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (file: string) => {
      state.files.push(file);
      if (path.basename(file) === ".credentials.json") {
        return Promise.resolve(JSON.stringify(state.signedIn
          ? { claudeAiOauth: { accessToken: "fixture", rateLimitTier: "max_20x" } }
          : {}));
      }
      return Promise.resolve(
        JSON.stringify({
          oauthAccount: {
            emailAddress: "claude@example.com",
            accountUuid: "4f6c1d2e-8a9b-4c3d-9e1f-2a3b4c5d6e7f",
          },
        }),
      );
    },
  },
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@get-bb/plugin-sdk/provider-bridge")
  >()),
  experimental_resolveExecutablePath: () => Promise.resolve("/test/claude"),
  experimental_readCliVersion: () => Promise.resolve("2.1.317"),
}));

import {
  getClaudeProviderHealth,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";

const originalPlatform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

beforeEach(() => {
  state.signedIn = true;
  state.files = [];
  vi.stubGlobal("fetch", async (input: string) =>
    Response.json(input.endsWith("/profile")
      ? { account: { rate_limit_tier: "max_20x" } }
      : { five_hour: { utilization: 40, resets_at: "2026-11-05T20:00:00Z" }, seven_day: null }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Claude Code account status", () => {
  it("reports the account Claude Code signs in with, keyed by the profile CLAUDE_CONFIG_DIR selects (test-change-reason: the fork reads the selected profile and its OAuth credential files)", async () => {
    const profile = path.resolve("/profiles/work");
    vi.stubEnv("CLAUDE_CONFIG_DIR", profile);

    expect(await getClaudeProviderUsage()).toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: "claude@example.com",
        planLabel: "Ultra",
        plan: { id: "ultra", multiplier: null },
        windows: [
          {
            kind: "five-hour",
            label: "Current session",
            usedPercent: 40,
            resetsAt: "2026-11-05T20:00:00.000Z",
          },
        ],
        accountKey: "anthropic:account:4f6c1d2e-8a9b-4c3d-9e1f-2a3b4c5d6e7f",
      },
    });
    expect(state.files.sort()).toEqual([path.join(profile, ".claude.json"), path.join(profile, ".credentials.json")].sort());
  });

  it.each(["missing credentials", "an API-key-only login"])(
    "reports usage as signed out for %s (test-change-reason: the fork requires a subscription credential for usage)",
    async (login) => {
      state.signedIn = false;
      if (login === "an API-key-only login") vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
      expect(await getClaudeProviderUsage()).toEqual({
        supported: true,
        usage: { status: "unauthenticated" },
      });
    },
  );

  it("reports health from the account Claude Code signs in with (test-change-reason: the fork checks local OAuth credentials for health)", async () => {
    expect(await getClaudeProviderHealth()).toMatchObject({
      health: {
        status: "ready",
        accountEmail: "claude@example.com",
        planLabel: "Ultra",
      },
    });

    state.signedIn = false;
    expect(await getClaudeProviderHealth()).toMatchObject({
      health: { status: "unauthenticated", accountEmail: null },
    });
  });
});
