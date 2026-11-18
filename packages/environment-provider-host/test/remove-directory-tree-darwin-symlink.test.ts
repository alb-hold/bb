import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TIMESTAMP_LAG_MS,
  RetainedRecoveryError,
  removeDirectoryTree,
  type RemoveDirectoryTreeHooks,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function linkTree(
  target = "../target.txt",
): Promise<{ root: string; bin: string; link: string }> {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-darwin-link-"));
  roots.push(parent);
  const root = path.join(parent, "tree");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(root, "target.txt"), "target");
  const link = path.join(bin, "tool");
  await fs.symlink(target, link);
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { root, bin, link };
}

async function names(root: string): Promise<string[]> {
  const listed = await fs.readdir(root, { recursive: true });
  return listed.map(String).sort();
}

const original = ["bin", "bin/tool", "target.txt"];

function quarantineHooks(isLink: (entry: string) => boolean): Pick<
  RemoveDirectoryTreeHooks,
  "afterEntryQuarantined"
> & {
  quarantined: () => string;
} {
  let seen = "";
  return {
    quarantined: () => seen,
    afterEntryQuarantined: async (entry, quarantined) => {
      if (isLink(entry)) seen = quarantined;
    },
  };
}

describe.runIf(process.platform === "darwin")(
  "removing symbolic links on macOS",
  () => {
    it("removes a tree holding a symbolic link to an existing file", async () => {
      const { root } = await linkTree();
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
      });
      expect(result).toEqual({
        status: "removed",
        retainedPaths: [],
        mountedPaths: [],
        unanchoredPaths: [],
        notRespondingPaths: [],
        stoppedPaths: [],
        removalStarted: true,
      });
      await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("removes a tree holding a dangling symbolic link", async () => {
      const { root } = await linkTree("../missing.txt");
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
      });
      expect(result.status).toBe("removed");
      await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps a racer that takes the link's name before the link is restored", async () => {
      const { root, link } = await linkTree();
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        afterEntryQuarantined: async (entry) => {
          if (entry !== link) return;
          await fs.writeFile(link, "racer");
          throw new Error("injected verification failure");
        },
      });
      expect(result.status).toBe("retained");
      await expect(fs.readFile(link, "utf8")).resolves.toBe("racer");
      const leftovers = (await names(root)).filter(
        (name) => !original.includes(name),
      );
      expect(leftovers).toHaveLength(1);
      expect(leftovers[0]).toMatch(/^bin\/\.bb-removing-/u);
      expect(result.retainedPaths).toContain(path.join(root, leftovers[0]!));
      await expect(fs.readlink(path.join(root, leftovers[0]!))).resolves.toBe(
        "../target.txt",
      );
    });

    it("does not unlink a regular file a racer swaps in for the quarantined link", async () => {
      const { root, bin, link } = await linkTree();
      const hooks = quarantineHooks((entry) => entry === link);
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        afterEntryQuarantined: hooks.afterEntryQuarantined,
        afterParentVerified: async (entry) => {
          if (entry !== link) return;
          const staged = path.join(bin, "staged");
          await fs.writeFile(staged, "racer data");
          await fs.rename(
            staged,
            path.join(bin, path.basename(hooks.quarantined())),
          );
        },
      });
      expect(result.status).toBe("retained");
      const swapped = path.join(bin, path.basename(hooks.quarantined()));
      await expect(fs.readFile(swapped, "utf8")).resolves.toBe("racer data");
      expect(result.retainedPaths).toContain(swapped);
    });

    it("does not unlink a different link with the same target swapped in for the quarantined link", async () => {
      const { root, bin, link } = await linkTree();
      const hooks = quarantineHooks((entry) => entry === link);
      let racerIno = 0;
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        afterEntryQuarantined: hooks.afterEntryQuarantined,
        afterParentVerified: async (entry) => {
          if (entry !== link) return;
          const staged = path.join(bin, "staged");
          await fs.symlink("../target.txt", staged);
          racerIno = (await fs.lstat(staged)).ino;
          await fs.rename(
            staged,
            path.join(bin, path.basename(hooks.quarantined())),
          );
        },
      });
      expect(result.status).toBe("retained");
      const swapped = path.join(bin, path.basename(hooks.quarantined()));
      expect((await fs.lstat(swapped)).ino).toBe(racerIno);
      expect(result.retainedPaths).toContain(swapped);
    });

    const steps: Array<{
      step: string;
      hooks: (link: string) => RemoveDirectoryTreeHooks;
    }> = [
      {
        step: "rename",
        hooks: (link) => ({
          beforeEntryRename: async (entry) => {
            if (entry === link) throw new Error("injected rename failure");
          },
        }),
      },
      {
        step: "verify",
        hooks: (link) => ({
          afterEntryQuarantined: async (entry) => {
            if (entry === link) throw new Error("injected verify failure");
          },
        }),
      },
      {
        step: "readlink",
        hooks: () => {
          let failed = false;
          return {
            readSymbolicLink: async (entry) => {
              if (!failed && path.basename(entry).startsWith(".bb-removing-")) {
                failed = true;
                throw Object.assign(new Error("injected readlink failure"), {
                  code: "EIO",
                });
              }
              return fs.readlink(entry);
            },
          };
        },
      },
      {
        step: "unlink",
        hooks: () => {
          let failed = false;
          return {
            beforeEntryUnlink: async () => {
              if (failed) return;
              failed = true;
              throw new Error("injected unlink failure");
            },
          };
        },
      },
    ];

    for (const { step, hooks } of steps) {
      it(`restores the link's original name after a failure at ${step}`, async () => {
        const { root, link } = await linkTree();
        const result = await removeDirectoryTree(root, {
          startedAt: Date.now(),
          ...hooks(link),
        });
        expect(result.status).toBe("retained");
        expect(await names(root)).toEqual(original);
        await expect(fs.readlink(link)).resolves.toBe("../target.txt");
      });
    }

    it("names the quarantined link when restoring it fails", async () => {
      const { root, link } = await linkTree();
      const removal = removeDirectoryTree(root, {
        startedAt: Date.now(),
        afterEntryQuarantined: async (entry) => {
          if (entry === link) throw new Error("injected verify failure");
        },
        beforeQuarantineRestoreLink: async (_source, destination) => {
          if (destination.endsWith("/tool"))
            throw new Error("injected restore failure");
        },
      });
      const error = await removal.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RetainedRecoveryError);
      const leftovers = (await names(root)).filter(
        (name) => !original.includes(name),
      );
      expect(leftovers).toHaveLength(1);
      expect(leftovers[0]).toMatch(/^bin\/\.bb-removing-/u);
      expect((error as RetainedRecoveryError).retainedPaths).toContain(
        path.join(root, leftovers[0]!),
      );
    });
  },
);
