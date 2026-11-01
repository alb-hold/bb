import { internal_DO_NOT_USE_claudeProfileSchema as claudeProfileSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export { claudeProfileSchema };
export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;

export function claudePlanFromProfile(profile: ClaudeProfile): {
  subscriptionType: string | null;
  rateLimitTier: string | null;
} {
  return {
    subscriptionType: profile.account.has_claude_max
      ? "max"
      : profile.account.has_claude_pro
        ? "pro"
        : (profile.account.subscription_type ??
          profile.organization?.organization_type ??
          null),
    rateLimitTier:
      profile.account.rate_limit_tier ??
      profile.organization?.rate_limit_tier ??
      null,
  };
}
