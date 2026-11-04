import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { sharedViteConfig } from "../vite.config";

it("keeps route-only chunks out of startup HTML preloads", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bb-route-preload-")),
  );
  try {
    await Promise.all(
      Object.entries({
        "index.html":
          '<html><head><script>localStorage.getItem("bb.theme")</script><script type="module" src="/main.js"></script></head></html>',
        "main.js":
          'import { value } from "./shared.js"; window.value = value; window.route = () => import("./src/views/SplitWorkspaceRoute.tsx"); window.other = () => import("./other.js"); window.markdown = () => import("./src/components/ui/markdown-html.tsx"); window.queue = () => import("./src/components/promptbox/banner/QueuedMessagesList.tsx");',
        "shared.js": "export const value = Math.random();",
        "src/views/SplitWorkspaceRoute.tsx":
          'import { value } from "../../shared.js"; import { extra } from "../../route-dep.js"; export default value + extra;',
        "route-dep.js":
          'export const extra = Math.random(); window.routeDep = () => import("./route-lazy.js");',
        "route-lazy.js": "window.routeLazy = true;",
        "other.js": "window.other = true;",
        "src/components/ui/markdown-html.tsx": "window.markdown = true;",
        "src/components/promptbox/banner/QueuedMessagesList.tsx":
          "window.queue = true;",
      }).map(async ([name, source]) => {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), source);
      }),
    );
    await build({
      root,
      base: "/app/",
      configFile: false,
      logLevel: "silent",
      plugins: sharedViteConfig.plugins.filter(
        (plugin) => !Array.isArray(plugin) && "transformIndexHtml" in plugin,
      ),
      build: { minify: false },
    });
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    const preloaded = [
      ...html.matchAll(
        /<link rel="modulepreload" crossorigin href="([^"]+)">/g,
      ),
    ].map((match) => match[1] ?? "");
    expect(preloaded.some((href) => href.includes("SplitWorkspaceRoute"))).toBe(
      false,
    );
    expect(preloaded.some((href) => href.includes("route-dep"))).toBe(false);
    expect(preloaded.some((href) => href.includes("route-lazy"))).toBe(false);
    expect(preloaded.some((href) => href.includes("other"))).toBe(false);
    expect(html).toContain("bb-prefetch-markdown-html");
    expect(html).toContain("bb-prefetch-queued-messages-list");
    expect(new Set(preloaded).size).toBe(preloaded.length);
    for (const href of preloaded) {
      expect(href.startsWith("/app/assets/")).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
