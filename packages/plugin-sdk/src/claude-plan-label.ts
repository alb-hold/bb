export function claudeLocalPlanLabel(credentials: {
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}): string {
  const subscription = credentials.subscriptionType;
  const tier = credentials.rateLimitTier?.match(/max_(\d+)x/iu)?.[1];
  if (tier === "20") return "Ultra";
  if (!subscription || /max/iu.test(subscription) || tier !== undefined) {
    return "Claude subscription";
  }
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

export function claudeProfilePlanLabel(profile: {
  account: { rate_limit_tier?: string | null };
  organization?: {
    plan_display_name?: string | null;
    rate_limit_tier?: string | null;
  } | null;
}): string | null {
  const name =
    profile.organization?.plan_display_name?.replace(/^Claude\s+/iu, "") ??
    null;
  const max =
    profile.account.rate_limit_tier?.match(/max_(\d+)x/u) ??
    profile.organization?.rate_limit_tier?.match(/max_(\d+)x/u);
  if (max) return max[1] === "20" ? "Ultra" : "Claude subscription";
  return name !== null && /max/iu.test(name) ? "Claude subscription" : name;
}
