import { execFile } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function findChromium(): string | null {
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

export async function warmUpChromium(chromiumPath: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bb-chromium-warmup-"));
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
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
