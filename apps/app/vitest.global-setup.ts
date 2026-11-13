import { execFile } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    appChromiumPath: string | null;
  }
}

const execFileAsync = promisify(execFile);

export default async function setup(project: TestProject) {
  const chromiumPath =
    [
      process.env.BB_TEST_CHROMIUM,
      ...globSync(
        join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
      ),
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
    ].find(
      (candidate): candidate is string =>
        candidate !== undefined && existsSync(candidate),
    ) ?? null;
  project.provide("appChromiumPath", chromiumPath);
  if (chromiumPath === null) return;
  const dir = await mkdtemp(join(tmpdir(), "bb-app-chromium-"));
  try {
    await execFileAsync(
      chromiumPath,
      [
        "--headless",
        `--user-data-dir=${join(dir, "profile")}`,
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
