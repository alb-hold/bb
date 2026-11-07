import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const mirroredFiles = [
  "worktree-holders.ts",
  "linux-path-access.ts",
  "session-agent-comms.ts",
] as const;

it.each(mirroredFiles)("keeps %s in sync with process-utils", async (file) => {
  const [shared, plugin] = await Promise.all([
    readFile(
      new URL(`../../../packages/process-utils/src/${file}`, import.meta.url),
      "utf8",
    ),
    readFile(new URL(`./${file}`, import.meta.url), "utf8"),
  ]);
  const normalized = shared.replaceAll(
    /@bb\/process-utils\/([\w-]+)/gu,
    "./$1.js",
  );

  expect(plugin).toBe(normalized);
});
