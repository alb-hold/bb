import { traceTerminalGate } from "@/lib/terminal-performance";

function loadTerminalModules() {
  return Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    importTerminalUnicodeAddon(),
  ]);
}

let requiredModules: ReturnType<typeof loadTerminalModules> | null = null;
let preloaded = false;

export function importTerminalModules() {
  requiredModules ??= loadTerminalModules().catch((error) => {
    requiredModules = null;
    throw error;
  });
  return requiredModules;
}

export function importTerminalSearchAddon() {
  return import("@xterm/addon-search");
}

export function importTerminalWebLinksAddon() {
  return import("@xterm/addon-web-links");
}

export function importTerminalUnicodeAddon() {
  return import("@xterm/addon-unicode11");
}

export function importTerminalWebglAddon() {
  return import("@xterm/addon-webgl");
}

export function preloadTerminalModules(): void {
  if (preloaded) return;
  preloaded = true;
  void traceTerminalGate(
    "terminal-runtime-preload",
    importTerminalModules,
  ).catch(() => {
    preloaded = false;
  });
  void importTerminalSearchAddon().catch(() => undefined);
  void importTerminalWebLinksAddon().catch(() => undefined);
  void importTerminalWebglAddon().catch(() => undefined);
}
