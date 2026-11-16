import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ParcelWatcherSubscribeOptions } from "./parcel-watcher-backend.js";

function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): boolean {
  if (env.PATH === undefined) return false;
  for (const entry of env.PATH.split(path.delimiter)) {
    const candidate = path.join(path.resolve(cwd, entry || "."), name);
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
  if (executableOnPath("watchman", env, cwd)) return opts;
  return { ...opts, backend: platform === "linux" ? "inotify" : "fs-events" };
}
