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
