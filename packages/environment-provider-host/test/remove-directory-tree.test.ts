import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (
      target: Parameters<typeof fs.lstat>[0],
      options?: Parameters<typeof fs.lstat>[1],
    ) => {
      const info = await fs.lstat(target, options);
      if (options?.bigint === true) return info;
      Object.defineProperty(info, "ctimeMs", { value: 1 });
      Object.defineProperty(info, "mtimeMs", { value: 1 });
      return info;
    },
  };
});

import { removeDirectoryTree } from "../src/remove-directory-tree.js";

const roots: string[] = [];

afterEach(async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it("retains an in-place edit between ordinary and precise ctime snapshots", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-tree-ctime-"));
  roots.push(root);
  const entry = path.join(root, "payload.txt");
  await fs.writeFile(entry, "before\n");
  const before = await fs.stat(entry, { bigint: true });
  let injected = false;

  const result = await removeDirectoryTree(root, {
    startedAt: Number.MAX_SAFE_INTEGER,
    afterEntryCheck: async (checkedEntry) => {
      if (checkedEntry !== entry) return;
      injected = true;
      await fs.writeFile(entry, "after!\n");
      await fs.utimes(
        entry,
        Number(before.atimeNs) / 1_000_000_000,
        Number(before.mtimeNs) / 1_000_000_000,
      );
    },
  });

  expect(injected).toBe(true);
  expect(result).toBe("retained");
  await expect(fs.readFile(entry, "utf8")).resolves.toBe("after!\n");
});
