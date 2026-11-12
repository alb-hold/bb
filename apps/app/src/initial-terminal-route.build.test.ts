import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, it, vi } from "vitest";
import { sharedViteConfig } from "../vite.config";

it("warms the native thread module while the app shell is still pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-native-route-"));
  const connector = await readFile(
    resolve(import.meta.dirname, "lib/initial-terminal-connect.ts"),
    "utf8",
  );
  const loader = await readFile(
    resolve(import.meta.dirname, "views/thread-detail/thread-detail-loader.ts"),
    "utf8",
  ).catch(() => "");
  let release = () => {};
  const shellReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { loaded: 0, warmed: 0, shell: 0 };
  const key = `__bbNativeRouteTest${Date.now()}`;
  vi.stubGlobal(key, { state, shellReady });
  try {
    const files = {
      "package.json": '{"type":"module"}',
      "main.ts": `import { LazyThreadDetailView } from "./src/views/thread-detail/LazyThreadDetailView"; await globalThis.${key}.shellReady; globalThis.${key}.state.shell++; export { LazyThreadDetailView };`,
      "src/lib/initial-terminal-connect.ts": connector,
      "src/lib/terminal-performance.ts":
        "export function markTerminalPerformance() {}",
      "src/lib/device-handoff-identity.ts":
        'export function ensureDeviceHandoffId() { return "device"; }',
      "src/lib/initial-native-terminal-request.ts": "",
      "src/lib/retryable-chunk-import.ts": await readFile(
        resolve(import.meta.dirname, "lib/retryable-chunk-import.ts"),
        "utf8",
      ),
      "src/components/thread/terminal/terminal-socket-prefetch.ts":
        "export function prefetchTerminalSocket() {}",
      "src/components/thread/terminal/terminal-websocket-url.ts":
        'export function buildTerminalWebSocketUrl() { return "ws://localhost/terminal"; }',
      "src/components/thread/terminal/native-terminal-panel-loader.ts":
        "export function loadNativeTerminalPanel() { return Promise.resolve(); }",
      "src/components/thread/terminal/terminal-modules.ts":
        "export function preloadTerminalModules() {}",
      "src/views/thread-detail/LazyThreadDetailView.ts": `import "../../../main"; export const LazyThreadDetailView = { preload: () => import("./ThreadDetailView").then(() => { globalThis.${key}.state.warmed++; }) };`,
      "src/views/thread-detail/ThreadDetailView.ts": `globalThis.${key}.state.loaded++; export function ThreadDetailView() {}`,
      "src/views/thread-detail/thread-detail-loader.ts": loader,
    };
    await Promise.all(
      Object.entries(files).map(async ([name, source]) => {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), source);
      }),
    );
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@": join(root, "src") } },
      build: {
        target: "esnext",
        minify: false,
        modulePreload: false,
        rolldownOptions: {
          input: {
            app: join(root, "main.ts"),
            connector: join(root, "src/lib/initial-terminal-connect.ts"),
          },
          output: {
            ...sharedViteConfig.build.rolldownOptions.output,
            entryFileNames: "[name].mjs",
          },
        },
      },
    });
    vi.stubGlobal("location", { pathname: "/threads/native" });
    globalThis.__bbInitialNativeTerminalRequest = {
      path: "/api/v1/threads/native/native-terminal",
      response: Promise.resolve(
        new Response(
          JSON.stringify({
            threadId: "native",
            terminal: { id: "terminal", status: "running" },
          }),
        ),
      ),
    };
    await import(
      /* @vite-ignore */ pathToFileURL(join(root, "dist/connector.mjs")).href
    );
    await expect.poll(() => state.loaded).toBe(1);
    expect(state.shell).toBe(0);
    release();
    await import(
      /* @vite-ignore */ pathToFileURL(join(root, "dist/app.mjs")).href
    );
    await expect.poll(() => state.warmed).toBe(1);
    expect(state.loaded).toBe(1);
    expect(state.shell).toBe(1);
  } finally {
    release();
    vi.unstubAllGlobals();
    delete globalThis.__bbInitialNativeTerminalRequest;
    await rm(root, { recursive: true, force: true });
  }
});
