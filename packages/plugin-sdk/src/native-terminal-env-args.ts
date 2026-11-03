import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeTerminalEnvArgs, type ProviderNativeTerminal } from "@bb/domain";
import { parse } from "smol-toml";
import { z } from "zod";

const configSchema = z.record(z.string(), z.unknown());
const patternsSchema = z.array(z.string().min(1).max(256)).max(512);
const policySchema = z
  .object({
    exclude: patternsSchema.optional(),
    include_only: patternsSchema.optional(),
    filters: z
      .record(z.string().min(1).max(256), z.enum(["include", "exclude"]))
      .optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

function readConfig(file: string): z.infer<typeof configSchema> {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    return configSchema.parse(parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
}

export function experimental_nativeTerminalEnvArgs(
  declaration: ProviderNativeTerminal["experimental_launchEnvArgs"],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string[] {
  const args = nativeTerminalEnvArgs(declaration, env);
  const recipe = declaration?.experimental_filterConfig;
  if (args.length === 0 || recipe === undefined) return args;
  const platform = os.platform();
  if (recipe.unsupportedPlatforms?.some((value) => value === platform)) {
    throw new Error(
      `Pooled launches on ${platform} are unsupported: ${recipe.setting} cannot be checked safely.`,
    );
  }
  const root =
    (recipe.root.env === null ? undefined : env[recipe.root.env]) ||
    path.join(env.HOME ?? os.homedir(), recipe.root.home);
  const file = path.resolve(root, recipe.file);
  let activeFile = file;
  try {
    const presenceFiles =
      platform === "darwin" || platform === "linux" || platform === "win32"
        ? (recipe.presenceFiles?.[platform] ?? [])
        : [];
    for (const candidate of presenceFiles) {
      activeFile = candidate.replaceAll("{username}", os.userInfo().username);
      try {
        statSync(activeFile);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      throw new Error();
    }
    const candidates = [...(recipe.policyFiles ?? [])];
    if (recipe.ancestorFile !== undefined) {
      let directory = realpathSync(cwd);
      for (;;) {
        const candidate = path.join(directory, recipe.ancestorFile);
        if (candidate !== file) candidates.push(candidate);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const candidate of candidates) {
      activeFile = candidate;
      if (recipe.setting in readConfig(candidate)) throw new Error();
    }
    activeFile = file;
    const config = readConfig(file);
    if ("profile" in config) throw new Error();
    const policy = policySchema.parse(
      config[recipe.setting] === undefined ? {} : config[recipe.setting],
    );
    for (const key of Object.keys(policy.set ?? {})) {
      if (
        recipe.exclude.some((pattern) => {
          const expression = pattern
            .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
            .replace(/\*/gu, ".*")
            .replace(/\?/gu, ".");
          return new RegExp(`^${expression}$`, "iu").test(key);
        })
      )
        throw new Error();
    }
    if (
      policy.filters !== undefined &&
      (policy.exclude !== undefined || policy.include_only !== undefined)
    )
      throw new Error();
    if (Object.keys(policy.filters ?? {}).length > 512) throw new Error();
    const filters = new Map<
      string,
      { pattern: string; action: "include" | "exclude" }
    >();
    const add = (pattern: string, action: "include" | "exclude") => {
      const key = pattern.toLowerCase();
      const previous = filters.get(key);
      if (previous !== undefined && previous.action !== action)
        throw new Error();
      filters.set(key, { pattern, action });
    };
    for (const [pattern, action] of Object.entries(policy.filters ?? {}))
      add(pattern, action);
    for (const pattern of policy.exclude ?? []) add(pattern, "exclude");
    for (const pattern of policy.include_only ?? []) add(pattern, "include");
    for (const pattern of recipe.exclude) add(pattern, "exclude");
    const table = [...filters.values()]
      .map(
        ({ pattern, action }) =>
          `${JSON.stringify(pattern)}=${JSON.stringify(action)}`,
      )
      .join(",");
    return [...args, recipe.flag, `${recipe.setting}.filters={${table}}`];
  } catch {
    throw new Error(
      `Cannot safely translate ${recipe.setting} in ${activeFile} for a pooled launch. Move the policy to ${file} or remove it; check syntax and unsupported settings there.`,
    );
  }
}
