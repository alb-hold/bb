import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  FILE_TIMESTAMP_LAG_MS,
  type RemoveDirectoryTreeHooks,
} from "bb-environment-provider-host/remove-directory-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeDirectoryAfterHolderRecheck } from "./remove-held-directory.js";

const injected = vi.hoisted(() => ({
  hooks: null as null | (() => RemoveDirectoryTreeHooks),
}));

vi.mock(
  "bb-environment-provider-host/remove-directory-tree",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("bb-environment-provider-host/remove-directory-tree")
      >();
    return {
      ...actual,
      removeDirectoryTree: (
        root: string,
        hooks: RemoveDirectoryTreeHooks = {},
      ) =>
        actual.removeDirectoryTree(root, {
          ...hooks,
          ...(injected.hooks?.() ?? {}),
        }),
    };
  },
);

const roots: string[] = [];

afterEach(async () => {
  injected.hooks = null;
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function storage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-held-reasons-"));
  roots.push(root);
  const directory = path.join(root, "thr_storage");
  for (const name of ["a", "b"]) {
    await fs.mkdir(path.join(directory, name), { recursive: true });
    await fs.writeFile(path.join(directory, name, "out.txt"), name);
  }
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return directory;
}

function failingAnchors(
  failNow: () => boolean,
): Pick<RemoveDirectoryTreeHooks, "statDescriptor"> {
  return {
    statDescriptor: async (candidate) => {
      if (failNow())
        throw Object.assign(new Error(`ENOENT: ${candidate}`), {
          code: "ENOENT",
        });
      return fs.stat(candidate);
    },
  };
}

async function refusal(directory: string): Promise<string> {
  const error = await removeDirectoryAfterHolderRecheck({
    directory,
    action: "delete",
    recursive: true,
    testWorktreeHolderScan: { status: "clear" },
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: "path_in_use" });
  return (error as Error).message;
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "the reasons a thread-storage removal gives when a directory cannot be anchored",
  () => {
    it("names only the anchor failure when it fails before anything is removed", async () => {
      const directory = await storage();
      injected.hooks = () => failingAnchors(() => true);
      const message = await refusal(directory);
      expect(message).toContain(
        "could not anchor directory on this filesystem",
      );
      expect(message).not.toContain("new or changed");
      expect(message).not.toContain("partially removed");
      await expect(
        fs.readFile(path.join(directory, "a", "out.txt"), "utf8"),
      ).resolves.toBe("a");
    });

    it("says the directory may be partially removed when the anchor fails after removal began", async () => {
      const directory = await storage();
      let removing = false;
      injected.hooks = () => ({
        ...failingAnchors(() => removing),
        beforeEntryRename: async () => {
          removing = true;
        },
      });
      const message = await refusal(directory);
      expect(removing).toBe(true);
      expect(message).toContain(
        "could not anchor directory on this filesystem",
      );
      expect(message).toContain("partially removed");
      expect(message).not.toContain("new or changed");
    });
  },
);
