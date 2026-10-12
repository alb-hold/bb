import { nativeTerminalEnvArgs, type ProviderNativeTerminal } from "@bb/domain";

export const CODEX_POOL_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL";
export const CODEX_POOL_AUTH_TOKEN_ENV = "CODEX_POOL_AUTH_TOKEN";

export const CODEX_POOL_LAUNCH_ENV_ARGS: NonNullable<
  ProviderNativeTerminal["experimental_launchEnvArgs"]
> = {
  required: [CODEX_POOL_BASE_URL_ENV, CODEX_POOL_AUTH_TOKEN_ENV],
  args: [
    "-c",
    { env: CODEX_POOL_BASE_URL_ENV, prefix: "openai_base_url=" },
    "-c",
    'model_provider="bb-account-pool"',
    "-c",
    'model_providers.bb-account-pool.name="OpenAI"',
    "-c",
    {
      env: CODEX_POOL_BASE_URL_ENV,
      prefix: "model_providers.bb-account-pool.base_url=",
    },
    "-c",
    'model_providers.bb-account-pool.wire_api="responses"',
    "-c",
    "model_providers.bb-account-pool.requires_openai_auth=true",
    "-c",
    "model_providers.bb-account-pool.supports_websockets=false",
    "-c",
    `model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token="${CODEX_POOL_AUTH_TOKEN_ENV}"`,
  ],
};

export function codexPoolLaunchArgs(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return nativeTerminalEnvArgs(CODEX_POOL_LAUNCH_ENV_ARGS, env);
}
