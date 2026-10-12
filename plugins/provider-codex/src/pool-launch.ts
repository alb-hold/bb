export const CODEX_POOL_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL";
export const CODEX_POOL_AUTH_TOKEN_ENV = "CODEX_POOL_AUTH_TOKEN";

export function codexPoolLaunchArgs(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const baseUrl = env[CODEX_POOL_BASE_URL_ENV];
  if (!baseUrl || !env[CODEX_POOL_AUTH_TOKEN_ENV]) return [];
  return [
    "-c",
    `openai_base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    'model_provider="bb-account-pool"',
    "-c",
    'model_providers.bb-account-pool.name="OpenAI"',
    "-c",
    `model_providers.bb-account-pool.base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    'model_providers.bb-account-pool.wire_api="responses"',
    "-c",
    "model_providers.bb-account-pool.requires_openai_auth=true",
    "-c",
    "model_providers.bb-account-pool.supports_websockets=false",
    "-c",
    `model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token="${CODEX_POOL_AUTH_TOKEN_ENV}"`,
  ];
}
