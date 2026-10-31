import { internal_DO_NOT_USE_claudeProfilePlanLabel as claudeProfilePlanLabel } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { familyQuotaSchema } from "./contracts.js";
import type { AccountSummary } from "./contracts.js";

export const modelWeeklySchema = z.record(
  z.string().trim().min(1),
  familyQuotaSchema,
);
export type ModelWeekly = z.infer<typeof modelWeeklySchema>;

export const poolDisplaySchema = z.object({
  plans: z.record(z.string(), z.string().min(1)),
  weekly: z.record(z.string(), modelWeeklySchema).default({}),
});

export type PoolDisplay = z.infer<typeof poolDisplaySchema>;

export function displayPlanLabel(
  account: Pick<AccountSummary, "subscriptionType" | "rateLimitTier">,
  displayName: string | null = null,
): string | null {
  if (displayName !== null) {
    return claudeProfilePlanLabel({
      account: { rate_limit_tier: account.rateLimitTier },
      organization: { plan_display_name: displayName },
    });
  }
  const plan = account.subscriptionType;
  if (/^(?:claude_)?max$/iu.test(plan ?? "")) return "Claude subscription";
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

export function modelWeeklyRows(
  account: Pick<AccountSummary, "familyWeekly">,
  models: ModelWeekly | undefined,
  now = Date.now(),
) {
  const windows = models ?? account.familyWeekly;
  return Object.entries(windows).flatMap(([name, quota]) =>
    quota === null || (quota.resetAt !== null && quota.resetAt <= now)
      ? []
      : [
          {
            name,
            quota,
          },
        ],
  );
}
