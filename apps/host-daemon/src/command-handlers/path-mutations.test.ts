import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirHostPath,
  moveHostFile,
  removeHostPath,
} from "./path-mutations.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-path-mutations-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("confined host path mutations", () => {
  it("creates, moves, and removes paths beneath the declared root", async () => {
    const root = await makeRoot();
    const folder = path.join(root, "projects");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: folder,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    const source = path.join(folder, "draft.md");
    const destination = path.join(folder, "plan.md");
    await fs.writeFile(source, "# Plan");
    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("# Plan");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: destination,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates missing parent directories when recursive is enabled", async () => {
    const root = await makeRoot();
    const nested = path.join(root, "projects", "archive", "2026");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: nested,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nested)).resolves.toMatchObject({});
  });

  it("removes empty directories non-recursively and requires recursive for non-empty directories", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: empty,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });

    const nonEmpty = path.join(root, "non-empty");
    await fs.mkdir(nonEmpty);
    await fs.writeFile(path.join(nonEmpty, "note.md"), "# Note");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toThrow();
    await expect(fs.stat(nonEmpty)).resolves.toMatchObject({});
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nonEmpty)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink escapes and refuses to remove the declared root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, "outside");
    await fs.symlink(outside, link);
    const escaped = path.join(link, "secret.md");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: escaped,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: root,
        rootPath: root,
        recursive: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("does not overwrite a move destination", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.md");
    const destination = path.join(root, "destination.md");
    await fs.writeFile(source, "source");
    await fs.writeFile(destination, "destination");

    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "path_exists" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("destination");
  });

  it("refuses to move a folder and leaves it and its contents in place", async () => {
    const root = await makeRoot();
    const source = path.join(root, "workspace");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "work.txt"), "keep");
    const destination = path.join(root, "moved");

    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      fs.readFile(path.join(source, "work.txt"), "utf8"),
    ).resolves.toBe("keep");
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to follow a symbolic link, whether it points at a file or a folder", async () => {
    const root = await makeRoot();
    const target = path.join(root, "real.txt");
    await fs.writeFile(target, "real");
    const folder = path.join(root, "folder");
    await fs.mkdir(folder);
    for (const [name, pointsTo] of [
      ["file-link", target],
      ["folder-link", folder],
    ] as const) {
      const link = path.join(root, name);
      await fs.symlink(pointsTo, link);
      await expect(
        moveHostFile({
          type: "host.move_file",
          sourcePath: link,
          destinationPath: path.join(root, `${name}-moved`),
          rootPath: root,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(path.join(root, `${name}-moved`))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    }
    await expect(fs.readFile(target, "utf8")).resolves.toBe("real");
  });

  it("moves a regular file by renaming it, keeping its inode and leaving nothing at the source", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "content");
    const before = await fs.stat(source);

    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(destination)).ino).toBe(before.ino);
  });

  it.each([
    ["a folder", async (source: string) => {
      await fs.rename(source, `${source}.orig`);
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "inside.txt"), "workspace");
    }],
    ["another regular file", async (source: string) => {
      await fs.rename(source, `${source}.orig`);
      await fs.writeFile(source, "swapped in");
    }],
  ])("refuses and puts back a source swapped for %s between the open and the rename", async (_label, swap) => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");

    await expect(
      moveHostFile(
        {
          type: "host.move_file",
          sourcePath: source,
          destinationPath: destination,
          rootPath: root,
        },
        { afterOpen: () => swap(source) },
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });

    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.lstat(source)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(`${source}.orig`, "utf8")).resolves.toBe(
      "original",
    );
  });

  it("refuses a source and a destination reached through a symlinked folder, and a removal through one", async () => {
    const root = await makeRoot();
    const real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, "a.txt"), "keep");
    await fs.symlink(real, path.join(root, "alias"));

    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: path.join(root, "alias", "a.txt"),
        destinationPath: path.join(root, "b.txt"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      moveHostFile({
        type: "host.move_file",
        sourcePath: path.join(real, "a.txt"),
        destinationPath: path.join(root, "alias", "b.txt"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: path.join(root, "alias", "a.txt"),
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      fs.readFile(path.join(real, "a.txt"), "utf8"),
    ).resolves.toBe("keep");
  });
});
