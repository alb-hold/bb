export interface SanitizeInheritedChildProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  shellPath?: string;
}

const INHERITED_AGENT_SESSION_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
]);

export function sanitizeInheritedChildProcessEnv(
  args: SanitizeInheritedChildProcessEnvArgs,
): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === undefined) {
      continue;
    }
    const normalizedKey =
      process.platform === "win32" ? key.toUpperCase() : key;
    if (
      normalizedKey === "NODE_ENV" ||
      normalizedKey.startsWith("BB_") ||
      INHERITED_AGENT_SESSION_ENV_KEYS.has(normalizedKey)
    ) {
      continue;
    }
    sanitizedEnv[normalizedKey === "PATH" ? "PATH" : key] = value;
  }
  if (args.shellPath !== undefined) {
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

const NPM_SCRIPT_POLICY_ENV_KEYS: ReadonlySet<string> = new Set([
  "npm_config_allow_scripts",
  "npm_config_ignore_scripts",
  "npm_config_foreground_scripts",
]);

export function omitNpmScriptPolicyEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NPM_SCRIPT_POLICY_ENV_KEYS.has(key.toLowerCase())) continue;
    childEnv[key] = value;
  }
  return childEnv;
}
