import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ParcelWatcherSubscribeOptions } from "./parcel-watcher-backend.js";

function executableOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (entry === "") continue;
    const candidate = path.join(entry, name);
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
): ParcelWatcherSubscribeOptions {
  if (opts?.backend !== undefined) return opts;
  if (platform !== "linux" && platform !== "darwin") return opts;
  if (executableOnPath("watchman", env)) return opts;
  return { ...opts, backend: platform === "linux" ? "inotify" : "fs-events" };
}
