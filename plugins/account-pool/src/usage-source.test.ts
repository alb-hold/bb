import { describe, expect, it } from "vitest";
import { usagePlanLabel, usageWindowLabel } from "./usage-source.js";

describe("usage presentation labels", () => {
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
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
    ).toBe("Max (20x)");
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
    ).toBe("Max");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "max",
        rateLimitTier: "max_20x",
      }),
    ).toBe("Claude subscription");
    expect(
      usagePlanLabel({
        provider: "claude",
        kind: "oauth",
        subscriptionType: "claude_max",
        rateLimitTier: "max_20x",
      }),
    ).toBe("Claude subscription");
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
    ).toBe("Claude subscription");
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
});
