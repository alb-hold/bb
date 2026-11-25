import { describe, expect, it } from "vitest";
import { accountBalance } from "./balancer.js";
import type { AccountQuota } from "./contracts.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function quota(
  windows: Array<{
    slot: "primary" | "secondary";
    windowMinutes: number | null;
    utilization: number;
    resetAt: number | null;
  }>,
): AccountQuota {
  return {
    accountId: "11111111-1111-4111-8111-111111111111",
    representativeClaim: null,
    familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: windows.map((window) => ({
      ...window,
      status: "allowed",
      observedAt: NOW,
      source: "usage",
    })),
    extraUsage: null,
    usageRestriction: null,
    observedAt: NOW,
    heldUntil: null,
    error: null,
  };
}

describe("accountBalance for Antigravity", () => {
  it("names the 5h and weekly windows and binds on the tighter one", () => {
    const balance = accountBalance(
      "gemini",
      quota([
        { slot: "primary", windowMinutes: 300, utilization: 0.2, resetAt: NOW + 2 * HOUR },
        { slot: "secondary", windowMinutes: 10_080, utilization: 0.7, resetAt: NOW + 48 * HOUR },
      ]),
      null,
      NOW,
    );
    expect(balance.windows.map((window) => window.kind)).toEqual(["five-hour", "weekly"]);
    expect(balance.bindingWindow).toBe("weekly");
    expect(balance.bindingHeadroom).toBeCloseTo(0.3);
  });

  it("does not let a reset seconds away inflate the recovery rate", () => {
    const balance = accountBalance(
      "gemini",
      quota([
        { slot: "primary", windowMinutes: 300, utilization: 0.5, resetAt: NOW + 1_000 },
      ]),
      null,
      NOW,
    );
    expect(balance.resetRecoveryPerHour).not.toBeNull();
    expect(balance.resetRecoveryPerHour ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6.01);
  });
});
