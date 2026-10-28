import { execFile } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    threadListPluginCss: string | null;
    threadListChromiumPath: string | null;
  }
}

const execFileAsync = promisify(execFile);

function findChromium(): string | null {
  const candidates = [
    process.env.BB_TEST_CHROMIUM,
    ...globSync(
      join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
    ),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        candidate !== undefined && existsSync(candidate),
    ) ?? null
  );
}

async function warmUpChromium(chromiumPath: string): Promise<void> {
  await execFileAsync(
    chromiumPath,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--dump-dom",
      "about:blank",
    ],
    { timeout: 120_000 },
  );
}

function insideMonorepo(from: string): boolean {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "turbo.json"))) return true;
    if (dir === parse(dir).root) return false;
  }
}

export default async function setup(project: TestProject) {
  const chromiumPath = findChromium();
  if (chromiumPath !== null) await warmUpChromium(chromiumPath);
  project.provide("threadListChromiumPath", chromiumPath);
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
