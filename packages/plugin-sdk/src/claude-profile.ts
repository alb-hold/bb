import { z } from "zod";

export const claudeProfileSchema = z
  .object({
    account: z
      .object({
        uuid: z.string().uuid().nullish(),
        email: z.string().email().nullish(),
        display_name: z.string().trim().min(1).nullish(),
        has_claude_max: z.boolean().nullish(),
        has_claude_pro: z.boolean().nullish(),
        subscription_type: z.string().trim().min(1).nullish(),
        rate_limit_tier: z.string().trim().min(1).nullish(),
      })
      .passthrough(),
    organization: z
      .object({
        uuid: z.string().uuid().nullish(),
        name: z.string().trim().min(1).nullish(),
        organization_type: z.string().trim().min(1).nullish(),
        plan_display_name: z.string().trim().min(1).nullish(),
        rate_limit_tier: z.string().trim().min(1).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;

export function claudeProfilePlanLabel(profile: ClaudeProfile): string | null {
  const name =
    profile.organization?.plan_display_name?.replace(/^Claude\s+/iu, "") ??
    null;
  const max =
    profile.account.rate_limit_tier?.match(/max_(\d+)x/u) ??
    profile.organization?.rate_limit_tier?.match(/max_(\d+)x/u);
  return name !== null && /^max$/iu.test(name) && max
    ? `Max (${max[1]}x)`
    : name;
}
