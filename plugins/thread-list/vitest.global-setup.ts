import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    threadListPluginCss: string | null;
  }
}

function insideMonorepo(from: string): boolean {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "turbo.json"))) return true;
    if (dir === parse(dir).root) return false;
  }
}

export default async function setup(project: TestProject) {
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  const cssPath = join(pluginRoot, ".bundled-runtime/dist/app.css");
  if (!insideMonorepo(pluginRoot)) {
    project.provide("threadListPluginCss", null);
    return;
  }
  if (!existsSync(cssPath)) {
    if (process.env.CI) {
      throw new Error(
        `${cssPath} is missing; run the suite through turbo so bb-plugin-thread-list#test builds prepare:bundled first`,
      );
    }
    project.provide("threadListPluginCss", null);
    return;
  }
  project.provide("threadListPluginCss", await readFile(cssPath, "utf8"));
}
