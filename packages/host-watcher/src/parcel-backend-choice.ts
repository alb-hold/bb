import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ParcelWatcherSubscribeOptions } from "./parcel-watcher-backend.js";

function searchedDirectory(
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "darwin" || !entry.startsWith("~"))
    return path.resolve(cwd, entry || ".");
  if (entry !== "~" && !entry.startsWith("~/")) return null;
  if (env.HOME === undefined || env.HOME === "") return null;
  return path.resolve(cwd, env.HOME + entry.slice(1));
}

function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): boolean {
  if (env.PATH === undefined) return false;
  for (const entry of env.PATH.split(path.delimiter)) {
    const directory = searchedDirectory(entry, env, cwd, platform);
    if (directory === null) continue;
    const candidate = path.join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function withPlatformParcelBackend(
  opts: ParcelWatcherSubscribeOptions,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ParcelWatcherSubscribeOptions {
  if (opts?.backend !== undefined) return opts;
  if (platform !== "linux" && platform !== "darwin") return opts;
  if (executableOnPath("watchman", env, cwd, platform)) return opts;
  return { ...opts, backend: platform === "linux" ? "inotify" : "fs-events" };
}
