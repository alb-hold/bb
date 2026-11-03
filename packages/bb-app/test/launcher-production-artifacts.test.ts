import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: () => false,
    readdirSync: () => [],
  };
});

import { runBbApp } from "../src/launcher.js";

it("production startup rejects missing artifacts before starting processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-production-artifacts-"));
  const beforeServerStart = vi.fn();
  try {
    await expect(
      runBbApp(
        [
          "start",
          "--data-dir",
          join(root, "data"),
          "--no-in-app-updates",
        ],
        { beforeServerStart, worktreePolicy: null },
      ),
    ).rejects.toThrow(/Missing host daemon entry/);
    expect(beforeServerStart).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
