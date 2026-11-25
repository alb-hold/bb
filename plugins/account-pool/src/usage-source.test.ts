import { describe, expect, it } from "vitest";

import {
  accountUsageWindows,
  usagePlanLabel,
  usagePlan,
  usageWindowLabel,
  windowResetState,
} from "./usage-source.js";

import { displayPlanLabel } from "./display.js";

describe("usage presentation labels", () => {
  it("uses legacy quota fields when normalized windows are empty", () => {
    expect(
      accountUsageWindows({
        limitWindows: [],
        fiveHourUtilization: 0.42,
        fiveHourResetAt: 1_800_000_000_000,
        sevenDayUtilization: 0.63,
        sevenDayResetAt: 1_800_000_100_000,
      }),
    ).toEqual([
      {
        id: "five-hour",
        label: "Five-hour limit",
        utilization: 0.42,
        resetAt: 1_800_000_000_000,
      },
      {
        id: "weekly",
        label: "Weekly limit",
        utilization: 0.63,
        resetAt: 1_800_000_100_000,
      },
    ]);
  });

  it.each([
    ["claude", "api-key", null, null, "Claude subscription"],
    ["codex", "oauth", "max", "max_20x", "Max (20x)"],
  ] as const)(
    "normalizes reported Max for %s %s accounts without changing other providers",
    (provider, kind, subscriptionType, rateLimitTier, expected) => {
      expect(
        displayPlanLabel(
          { provider, kind, subscriptionType, rateLimitTier },
          "Max",
        ),
      ).toBe(expected);
    },
  );

  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });

  it("names Claude plans after the Max and Ultra rename", () => {
    expect(
      usagePlan({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toEqual({ id: "ultra", label: "Ultra" });
    expect(
      usagePlan({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      }),
    ).toEqual({ id: "max", label: "Max" });
    expect(usagePlan({ subscriptionType: "max", rateLimitTier: null })).toEqual(
      { id: "max", label: "Max" },
    );
    expect(usagePlan({ subscriptionType: "pro", rateLimitTier: null })).toEqual(
      { id: "pro", label: "Pro" },
    );
    expect(
      usagePlan({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });

  it("uses a Max multiplier only with a stored provider Max name", () => {
    expect(
      usagePlanLabel(
        {
          provider: "claude",
          kind: "oauth",
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
        "Max",
      ),
    ).toBe("Ultra");
    expect(
      usagePlanLabel(
        {
          provider: "claude",
          kind: "oauth",
          subscriptionType: "max",
          rateLimitTier: null,
        },
        "Max",
      ),
    ).toBe("Claude subscription");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "max",
        rateLimitTier: "max_20x",
      }),
    ).toBe("Ultra");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "claude_max",
        rateLimitTier: "max_20x",
      }),
    ).toBe("Ultra");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "pro",
        rateLimitTier: null,
      }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: null,
        rateLimitTier: null,
      }),
    ).toBe("Claude subscription");
  });

  it("uses the shared Claude OAuth fallback without labeling other account types", () => {
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "pro",
        rateLimitTier: "max_20x",
      }),
    ).toBe("Ultra");
    expect(
      usagePlanLabel({
        provider: "codex",
        kind: "oauth",
        subscriptionType: "pro",
        rateLimitTier: null,
      }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({
        provider: "codex",
        kind: "oauth",
        subscriptionType: null,
        rateLimitTier: null,
      }),
    ).toBeNull();
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "api-key",
        subscriptionType: null,
        rateLimitTier: null,
      }),
    ).toBeNull();
  });

  it("retains known subscription labels for Claude API-key accounts", () => {
    expect(
      usagePlanLabel(
        {
          provider: "codex",
          kind: "oauth",
          subscriptionType: "max",
          rateLimitTier: "max_20x",
        },
        "Max",
      ),
    ).toBe("Max (20x)");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "api-key",
        subscriptionType: "pro",
        rateLimitTier: null,
      }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "api-key",
        subscriptionType: null,
        rateLimitTier: null,
      }),
    ).toBeNull();
    expect(
      usagePlanLabel({
        provider: "codex",
        kind: "oauth",
        subscriptionType: "pro",
        rateLimitTier: null,
      }),
    ).toBe("Pro");
  });
});

describe("window reset state", () => {
  const now = 1_800_000_000_000;

  it("keeps a future reset open and a missing reset open", () => {
    expect(windowResetState(now + 1, now)).toBe("open");
    expect(windowResetState(null, now)).toBe("open");
  });

  it("treats a reset inside the five-minute poll as rolled over, not stale", () => {
    expect(windowResetState(now, now)).toBe("rolled");
    expect(windowResetState(now - 4 * 60_000, now)).toBe("rolled");
    expect(windowResetState(now - 5 * 60_000, now)).toBe("rolled");
  });

  it("treats a reset older than a poll as expired", () => {
    expect(windowResetState(now - 5 * 60_000 - 1, now)).toBe("expired");
  });
});
