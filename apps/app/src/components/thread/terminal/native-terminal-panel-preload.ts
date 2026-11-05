import { loadChunkWithRetries } from "@/lib/retryable-chunk-import";

let pending: Promise<typeof import("./ThreadTerminalPanel")> | undefined;

export function preloadNativeTerminalPanel() {
  return (pending ??= loadChunkWithRetries(
    () => import("./ThreadTerminalPanel"),
  ).catch((error) => {
    pending = undefined;
    throw error;
  }));
}
