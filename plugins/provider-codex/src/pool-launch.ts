import { experimental_nativeTerminalEnvArgs } from "@get-bb/plugin-sdk/host";

export const CODEX_POOL_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL";
export const CODEX_POOL_AUTH_TOKEN_ENV = "CODEX_POOL_AUTH_TOKEN";

export function isCodexPoolEnvironmentVariable(name: string): boolean {
  return (
    name.toUpperCase() === CODEX_POOL_BASE_URL_ENV ||
    /^(?:CODEX_.*POOL.*|BB_ACCOUNT_POOL_.*)$/iu.test(name)
  );
}

export const CODEX_POOL_LAUNCH_ENV_ARGS: NonNullable<
  Parameters<typeof experimental_nativeTerminalEnvArgs>[0]
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
    "-c",
    'shell_environment_policy.filters.CODEX_*POOL*="exclude"',
    "-c",
    'shell_environment_policy.filters.BB_ACCOUNT_POOL_*="exclude"',
    "-c",
    'shell_environment_policy.filters.CODEX_OPENAI_BASE_URL="exclude"',
  ],
};

export function codexPoolLaunchArgs(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return experimental_nativeTerminalEnvArgs(CODEX_POOL_LAUNCH_ENV_ARGS, env);
}
