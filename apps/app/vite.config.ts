import { xtermFaintContrast } from "./vite-xterm-faint.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { bundleStats } from "./vite-bundle-stats.js";
import { splitPrefetch } from "./vite-split-prefetch.js";
import { initialThreadPreload } from "./vite-initial-thread-preload.js";
import { fontPreload } from "./vite-font-preload.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";
import { cachedReactCompiler } from "./vite-react-compiler.js";

const appDir = dirname(fileURLToPath(import.meta.url));

export const sharedViteConfig = {
  plugins: [
    xtermFaintContrast(),
    sharedUiEnvSeam(),
    react(),
    cachedReactCompiler(),
    tailwindcss(),
    bundleStats(),
    fontPreload(),
    initialThreadPreload(),
    splitPrefetch({
      "plugin-zod-runtime":
        "packages/plugin-build/src/generated/zod-runtime.generated.ts",
      "plugin-radix-runtime": "src/lib/plugin-radix-runtime.ts",
      "plugin-alert-runtime": "@radix-ui/react-alert-dialog/dist/index.mjs",
      "plugin-hover-runtime": "@radix-ui/react-hover-card/dist/index.mjs",
      "plugin-menubar-runtime": "@radix-ui/react-menubar/dist/index.mjs",
      "plugin-navigation-runtime":
        "@radix-ui/react-navigation-menu/dist/index.mjs",
      "plugin-select-runtime": "@radix-ui/react-select/dist/index.mjs",
      "plugin-vaul-runtime": "vaul/dist/index.mjs",
      "plugin-pierre-runtime": "src/lib/plugin-pierre-runtime.tsx",
      "thread-detail": "src/views/thread-detail/ThreadDetailView.tsx",
      "root-compose-panel-tab-content":
        "src/views/RootComposePanelTabContent.tsx",
      "thread-action-menu-items": "src/components/thread/ThreadMenuItems.tsx",
      "prompt-voice-runtime":
        "src/components/promptbox/usePromptVoiceRuntime.tsx",
      "model-reasoning-picker-body":
        "src/components/pickers/ModelReasoningPickerBody.tsx",
      "model-reasoning-menu": "src/components/pickers/ModelReasoningMenu.tsx",
      "extended-icons":
        "packages/shared-ui/src/components/ui/icon-extended.tsx",
      "thread-terminal":
        "src/components/thread/terminal/ThreadTerminalPanel.tsx",
      "terminal-runtime": "@xterm/xterm/lib/xterm.mjs",
      "terminal-fit": "@xterm/addon-fit/lib/addon-fit.mjs",
      "terminal-unicode": "@xterm/addon-unicode11/lib/addon-unicode11.mjs",
      "terminal-webgl": "@xterm/addon-webgl/lib/addon-webgl.mjs",
      "terminal-search": "@xterm/addon-search/lib/addon-search.mjs",
      "terminal-web-links": "@xterm/addon-web-links/lib/addon-web-links.mjs",
      "markdown-html": "src/components/ui/markdown-html.tsx",
      "queued-messages-list":
        "src/components/promptbox/banner/QueuedMessagesList.tsx",
    }),
  ],
  cacheDir: "node_modules/.vite/app",
  build: {
    reportCompressedSize: false,
    assetsInlineLimit: (filePath) =>
      filePath.includes("/workspace-open-target-icons/") ? false : undefined,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            {
              name: "terminal-connect",
              test: /src[\\/](?:lib[\\/](?:initial-terminal-connect|retryable-chunk-import)|components[\\/]thread[\\/]terminal[\\/]native-terminal-panel-loader)\.ts$/,
              priority: 4,
            },
            {
              name: "boot-icons",
              test: /@hugeicons[\/]core-free-icons/,
              tags: ["$initial"],
              priority: 3,
            },
            {
              name: "boot-vendor",
              test: /node_modules/,
              tags: ["$initial"],
              priority: 2,
              minSize: 12 * 1024,
            },
            {
              name: "boot-app",
              tags: ["$initial"],
              priority: 1,
              minSize: 12 * 1024,
            },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/xterm"],
  },
  resolve: {
    conditions: ["source"],
    alias: {
      "@": resolve(appDir, "./src"),
    },
  },
} satisfies UserConfig;

export default defineConfig(sharedViteConfig);
