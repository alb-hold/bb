export function resolveAcpAuthMethodId(
  authMethods: readonly { id: string }[],
  env: Record<string, string | undefined>,
): string | undefined {
  const methodIds = new Set(authMethods.map((method) => method.id));
  if (methodIds.size === 0) {
    return undefined;
  }
  if (env.XAI_API_KEY && methodIds.has("xai.api_key")) {
    return "xai.api_key";
  }
  if (
    env.GOOGLE_GENAI_USE_GCA === "true" &&
    env.GOOGLE_CLOUD_ACCESS_TOKEN &&
    methodIds.has("oauth-personal")
  ) {
    return "oauth-personal";
  }
  if (methodIds.has("cached_token")) {
    return "cached_token";
  }
  return undefined;
}
