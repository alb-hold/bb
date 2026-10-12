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
  ],
  experimental_filterConfig: {
    root: { env: "CODEX_HOME", home: ".codex" },
    file: "config.toml",
    setting: "shell_environment_policy",
    flag: "-c",
    exclude: ["CODEX_*POOL*", "BB_ACCOUNT_POOL_*", "CODEX_OPENAI_BASE_URL"],
    policyFiles: ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"],
    ancestorFile: ".codex/config.toml",
    presenceFiles: {
      darwin: [
        "/Library/Managed Preferences/com.openai.codex.plist",
        "/Library/Managed Preferences/{username}/com.openai.codex.plist",
      ],
    },
    unsupportedPlatforms: ["win32"],
  },
};

export function codexPoolLaunchArgs(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string[] {
  return experimental_nativeTerminalEnvArgs(
    CODEX_POOL_LAUNCH_ENV_ARGS,
    env,
    cwd,
  );
}
