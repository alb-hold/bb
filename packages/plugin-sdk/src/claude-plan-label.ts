export function claudeLocalPlanLabel(credentials: {
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}): string {
  const subscription = credentials.subscriptionType;
  if (
    !subscription ||
    /max/iu.test(subscription) ||
    /max_\d+x/iu.test(credentials.rateLimitTier ?? "")
  ) {
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
  return name !== null && /^max$/iu.test(name) && max
    ? `Max (${max[1]}x)`
    : name;
}
