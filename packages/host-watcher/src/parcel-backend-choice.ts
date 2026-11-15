import type { ParcelWatcherSubscribeOptions } from "./parcel-watcher-backend.js";

export function withPlatformParcelBackend(
  opts: ParcelWatcherSubscribeOptions,
  platform: NodeJS.Platform = process.platform,
): ParcelWatcherSubscribeOptions {
  if (opts?.backend !== undefined) return opts;
  if (platform === "linux") return { ...opts, backend: "inotify" };
  if (platform === "darwin") return { ...opts, backend: "fs-events" };
  return opts;
}
