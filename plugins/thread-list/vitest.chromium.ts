import { execFile } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function listChromiumCandidates(): string[] {
  const candidates = [
    process.env.BB_TEST_CHROMIUM,
    ...globSync(
      join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
    ),
    ...globSync(
      join(
        homedir(),
        ".cache/ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell",
      ),
    ),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return [
    ...new Set(
      candidates.filter(
        (candidate): candidate is string =>
          candidate !== undefined && existsSync(candidate),
      ),
    ),
  ];
}

export function findChromium(): string | null {
  return listChromiumCandidates()[0] ?? null;
}

export async function warmUpChromium(
  chromiumPath: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "bb-chromium-warmup-"));
  try {
    const { stdout } = await execFileAsync(
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
      { timeout: timeoutMs },
    );
    return /<html[\s>]/i.test(stdout);
  } catch {
    return false;
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

export async function resolveWorkingChromium(): Promise<string | null> {
  const candidates = listChromiumCandidates();
  for (const candidate of candidates) {
    if (await warmUpChromium(candidate, 15_000)) return candidate;
    console.warn(
      `[vitest.chromium] candidate failed --headless --dump-dom probe: ${candidate}`,
    );
  }
  return candidates[0] ?? null;
}
