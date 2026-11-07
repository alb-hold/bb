import { traceTerminalGate } from "@/lib/terminal-performance";
import { loadChunkWithRetries } from "@/lib/retryable-chunk-import";
import type { ThreadTerminalPanel } from "./ThreadTerminalPanel";

let loaded: typeof ThreadTerminalPanel | null = null;
let pending: Promise<typeof ThreadTerminalPanel> | null = null;

export function readNativeTerminalPanel() {
  return loaded;
}

export function loadNativeTerminalPanel() {
  pending ??= traceTerminalGate("terminal-native-panel-import", () =>
    loadChunkWithRetries(() => import("./ThreadTerminalPanel")),
  )
    .then((module) => {
      loaded = module.ThreadTerminalPanel;
      return loaded;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
