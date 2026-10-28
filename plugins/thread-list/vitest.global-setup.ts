import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    threadListPluginCss: string;
  }
}

const execFileAsync = promisify(execFile);

function findMonorepoRoot(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "turbo.json"))) return dir;
    if (dir === parse(dir).root) return null;
  }
}

export default async function setup(project: TestProject) {
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = findMonorepoRoot(pluginRoot);
  if (monorepoRoot === null) {
    project.provide("threadListPluginCss", "");
    return;
  }
  await execFileAsync(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "prepare:bundled",
      "--filter=bb-plugin-thread-list",
    ],
    { cwd: monorepoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  project.provide(
    "threadListPluginCss",
    await readFile(join(pluginRoot, ".bundled-runtime/dist/app.css"), "utf8"),
  );
}
