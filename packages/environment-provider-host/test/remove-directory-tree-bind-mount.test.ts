import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TIMESTAMP_LAG_MS,
  keptTreeReasons,
  removeDirectoryTree,
  type RemoveDirectoryTreeResult,
  type RemoveTreeFileHandle,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];
const modulePath = path.resolve(
  import.meta.dirname,
  "../src/remove-directory-tree-core.ts",
);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function mountNamespacesAvailable(): boolean {
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const runRemoval = `
const { removeDirectoryTree } = await import(process.argv[1]);
const result = await removeDirectoryTree(process.argv[2], {
  startedAt: Number.MAX_SAFE_INTEGER,
}).then(
  (value) => ({ value }),
  (error) => ({ thrown: String(error) }),
);
process.stdout.write(JSON.stringify(result));
`;

async function removeWithBind(
  source: string,
  target: string,
  root: string,
): Promise<{ value?: RemoveDirectoryTreeResult; thrown?: string }> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--mount",
        "sh",
        "-c",
        'mount --bind "$1" "$2" && exec "$3" --input-type=module -e "$4" "$5" "$6"',
        "sh",
        source,
        target,
        process.execPath,
        runRemoval,
        modulePath,
        root,
      ],
      (error, out, stderr) =>
        error === null
          ? resolve(out)
          : reject(new Error(`${error.message}\n${stderr}`)),
    );
  });
  return JSON.parse(stdout);
}

async function boundTree() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-bind-"));
  roots.push(parent);
  const source = path.join(parent, "source");
  const root = path.join(parent, "tree");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.writeFile(path.join(source, "a.txt"), "keep\n", { mode: 0o644 });
  await fs.writeFile(path.join(source, "nested", "b.txt"), "keep too\n");
  await fs.mkdir(path.join(root, "sub", "child"), { recursive: true });
  await fs.mkdir(path.join(root, "plain"));
  await fs.writeFile(path.join(root, "plain", "c.txt"), "removable\n");
  await fs.writeFile(path.join(root, "f.txt"), "");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { source, root };
}

async function settledTree(name = "tree") {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-mount-id-"));
  roots.push(parent);
  const root = path.join(parent, name);
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "kept.txt"), "kept\n");
  await fs.writeFile(path.join(root, "top.txt"), "top\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return root;
}

function escapedMountPoint(mountPoint: string): string {
  return mountPoint.replace(
    /[ \t\n\\]/gu,
    (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
}

function mountLine(mountPoint: string): string {
  return `36 1 0:51 / ${escapedMountPoint(mountPoint)} rw,relatime - tmpfs none rw\n`;
}

async function mountedTable(root: string): Promise<string> {
  return `${mountLine("/")}${mountLine(path.join(await fs.realpath(root), "elsewhere"))}`;
}

const linux = process.platform === "linux";

describe.runIf(linux)("removing a tree with a same-device bind mount", () => {
  it("keeps a bound directory as mounted and leaves the bind source whole", async (context) => {
    if (!mountNamespacesAvailable()) context.skip();
    const { source, root } = await boundTree();
    const child = path.join(root, "sub", "child");
    const removal = await removeWithBind(source, child, root);
    expect(removal.thrown).toBeUndefined();
    expect(removal.value).toMatchObject({
      status: "retained",
      mountedPaths: [child],
    });
    await expect(fs.readFile(path.join(source, "a.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(
      fs.readFile(path.join(source, "nested", "b.txt"), "utf8"),
    ).resolves.toBe("keep too\n");
  });

  it("keeps a bound file as mounted without failing, and leaves its source unchanged", async (context) => {
    if (!mountNamespacesAvailable()) context.skip();
    const { source, root } = await boundTree();
    const target = path.join(root, "f.txt");
    const removal = await removeWithBind(
      path.join(source, "a.txt"),
      target,
      root,
    );
    expect(removal.thrown).toBeUndefined();
    expect(removal.value).toMatchObject({
      status: "retained",
      mountedPaths: [target],
    });
    const after = await fs.stat(path.join(source, "a.txt"));
    expect(after.mode & 0o777).toBe(0o644);
    await expect(fs.readFile(path.join(source, "a.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  const shifted = (info: string) =>
    info.replace(
      /^mnt_id:\s*(\d+)$/mu,
      (_line, id: string) => `mnt_id:\t${Number(id) + 1}`,
    );

  it("keeps a tree whose root is itself a bind mount, before listing anything, and leaves the bind source whole", async (context) => {
    if (!mountNamespacesAvailable()) context.skip();
    const { source, root } = await boundTree();
    const removal = await removeWithBind(source, root, root);
    expect(removal.thrown).toBeUndefined();
    expect(removal.value).toMatchObject({
      status: "retained",
      mountedPaths: [root],
      removalStarted: false,
    });
    await expect(fs.readFile(path.join(source, "a.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(
      fs.readFile(path.join(source, "nested", "b.txt"), "utf8"),
    ).resolves.toBe("keep too\n");
  });

  it("keeps a tree whose .git marker is a bound file, before removing any sibling, and leaves the bind source unchanged", async (context) => {
    if (!mountNamespacesAvailable()) context.skip();
    const { source, root } = await boundTree();
    const marker = path.join(root, ".git");
    await fs.writeFile(marker, "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const removal = await removeWithBind(
      path.join(source, "a.txt"),
      marker,
      root,
    );
    expect(removal.thrown).toBeUndefined();
    expect(removal.value).toMatchObject({
      status: "retained",
      mountedPaths: [marker],
      removalStarted: false,
    });
    await expect(
      fs.readFile(path.join(root, "plain", "c.txt"), "utf8"),
    ).resolves.toBe("removable\n");
    await expect(fs.readFile(path.join(root, "f.txt"), "utf8")).resolves.toBe(
      "",
    );
    await expect(fs.readFile(marker, "utf8")).resolves.toBe(
      "gitdir: /nowhere\n",
    );
    const after = await fs.stat(path.join(source, "a.txt"));
    expect(after.mode & 0o777).toBe(0o644);
    await expect(fs.readFile(path.join(source, "a.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  it("keeps a tree whose .git is a FIFO with no writer, promptly and without opening it", async () => {
    const root = await settledTree();
    const marker = path.join(root, ".git");
    execFileSync("mkfifo", [marker]);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const started = performance.now();
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      status: "retained",
      unanchoredPaths: [marker],
      removalStarted: false,
    });
    expect((await fs.lstat(marker)).isFIFO()).toBe(true);
    await expect(fs.readFile(path.join(root, "top.txt"), "utf8")).resolves.toBe(
      "top\n",
    );
    await expect(
      fs.readFile(path.join(root, "nested", "kept.txt"), "utf8"),
    ).resolves.toBe("kept\n");
  }, 5_000);

  it.each([
    [
      "the inspection probe",
      (candidate: string, marker: string) => path.resolve(candidate) === marker,
    ],
    [
      "the held-marker open",
      (candidate: string, marker: string) => path.resolve(candidate) !== marker,
    ],
  ])(
    "never opens a .git swapped for a FIFO just before %s, and keeps the tree",
    async (label, swapsAt) => {
      const root = await settledTree();
      const marker = path.join(root, ".git");
      await fs.writeFile(marker, "gitdir: /nowhere\n");
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      const opened = path.join(path.dirname(root), "opened");
      let writer: ChildProcess | undefined;
      let swapped = "";
      const started = performance.now();
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        beforeMarkerOpen: async (candidate) => {
          if (writer !== undefined || !swapsAt(candidate, marker)) return;
          const real = path.join(
            await fs.realpath(path.dirname(candidate)),
            ".git",
          );
          await fs.rm(real);
          execFileSync("mkfifo", [real]);
          swapped = real;
          writer = spawn(
            "sh",
            ["-c", 'exec 3>"$1"; echo opened > "$2"', "sh", real, opened],
            { stdio: "ignore" },
          );
          await delay(100);
        },
      }).catch((error: unknown) => ({ thrown: String(error) }));
      await delay(200);
      const writerWaiting = writer?.exitCode === null;
      writer?.kill();
      expect(swapped).not.toBe("");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(existsSync(opened)).toBe(false);
      expect(writerWaiting).toBe(true);
      expect(result).toMatchObject({ status: "retained" });
      if (label !== "the inspection probe") return;
      await expect(
        fs.readFile(path.join(root, "nested", "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    },
    10_000,
  );

  it("keeps a tree whose .git marker is on another mount, before removing any sibling", async () => {
    const root = await settledTree();
    const marker = path.join(root, ".git");
    await fs.writeFile(marker, "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.resolve(entry) === marker ? shifted(info) : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [marker],
      removalStarted: false,
    });
    await expect(fs.readFile(path.join(root, "top.txt"), "utf8")).resolves.toBe(
      "top\n",
    );
  });

  it("keeps the .git marker when it becomes a mount after inspection, before pinning or moving it", async () => {
    const root = await settledTree();
    await fs.writeFile(path.join(root, ".git"), "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.basename(entry) === ".git" &&
          path.basename(path.dirname(entry)).startsWith(".bb-removing-")
          ? shifted(info)
          : info;
      },
    });
    expect(result.status).toBe("retained");
    expect(result.mountedPaths).toHaveLength(1);
    expect(path.basename(result.mountedPaths[0] ?? "")).toBe(".git");
    const left = await fs.readdir(path.dirname(root));
    const kept = left.includes("tree")
      ? path.join(path.dirname(root), "tree", ".git")
      : path.join(
          path.dirname(root),
          left.find((name) => name.startsWith(".bb-removing-")) ?? "",
          ".git",
        );
    await expect(fs.readFile(kept, "utf8")).resolves.toBe("gitdir: /nowhere\n");
  });

  it("keeps a tree whose root is on another mount than its parent", async () => {
    const root = await settledTree();
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.resolve(entry) === root ? shifted(info) : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [root],
      removalStarted: false,
    });
    await expect(fs.readFile(path.join(root, "top.txt"), "utf8")).resolves.toBe(
      "top\n",
    );
  });

  it("keeps the whole tree when its parent's mount id cannot be read", async () => {
    const root = await settledTree();
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: (entry, fd) =>
        path.resolve(entry) === path.dirname(root)
          ? Promise.reject(new Error("EACCES"))
          : fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8"),
    });
    expect(result).toMatchObject({
      status: "retained",
      unanchoredPaths: [root],
      removalStarted: false,
    });
    await expect(fs.readFile(path.join(root, "top.txt"), "utf8")).resolves.toBe(
      "top\n",
    );
  });

  it("keeps a directory on another mount before inspection lists it", async () => {
    const root = await settledTree();
    const nested = path.join(root, "nested");
    const listedDirectories: string[] = [];
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      afterDirectoryListed: async (directory) => {
        listedDirectories.push(path.resolve(directory));
      },
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.resolve(entry) === nested ? shifted(info) : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [nested],
      unanchoredPaths: [],
      removalStarted: false,
    });
    expect(listedDirectories).not.toContain(nested);
    expect(keptTreeReasons(result, (entry) => entry, "changed")).toContain(
      `a different filesystem is mounted here: ${nested}`,
    );
    await expect(
      fs.readFile(path.join(nested, "kept.txt"), "utf8"),
    ).resolves.toBe("kept\n");
  });

  it("keeps a directory that becomes a mount after inspection, before removing anything inside it", async () => {
    const root = await settledTree();
    const nested = path.join(root, "nested");
    let removing = false;
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      beforeEntryRemoval: async () => {
        removing = true;
      },
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return removing && path.resolve(entry) === nested
          ? shifted(info)
          : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [nested],
    });
    await expect(
      fs.readFile(path.join(nested, "kept.txt"), "utf8"),
    ).resolves.toBe("kept\n");
  });

  it("keeps a file on another mount without changing it", async () => {
    const root = await settledTree();
    const top = path.join(root, "top.txt");
    await fs.chmod(top, 0o644);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.resolve(entry) === top ? shifted(info) : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [top],
    });
    expect((await fs.stat(top)).mode & 0o777).toBe(0o644);
    await expect(fs.readFile(top, "utf8")).resolves.toBe("top\n");
  });

  it.each([
    ["cannot be read", () => Promise.reject(new Error("EACCES"))],
    ["has no mount id", () => Promise.resolve("pos:\t0\nflags:\t0100000\n")],
  ])(
    "keeps a directory whose descriptor info %s",
    async (_label, unreadable) => {
      const root = await settledTree();
      const nested = path.join(root, "nested");
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readMountTable: () => mountedTable(root),
        readDescriptorInfo: (entry, fd) =>
          path.resolve(entry) === nested
            ? unreadable()
            : fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8"),
      });
      expect(result).toMatchObject({
        status: "retained",
        mountedPaths: [],
        unanchoredPaths: [nested],
      });
      await expect(
        fs.readFile(path.join(nested, "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    },
  );

  it("keeps the whole tree when the root's own mount id cannot be read", async () => {
    const root = await settledTree();
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: (entry, fd) =>
        path.resolve(entry) === root
          ? Promise.reject(new Error("EACCES"))
          : fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8"),
    });
    expect(result).toMatchObject({
      status: "retained",
      unanchoredPaths: [root],
      removalStarted: false,
    });
    await expect(fs.readFile(path.join(root, "top.txt"), "utf8")).resolves.toBe(
      "top\n",
    );
  });

  it("removes an ordinary tree whose entries share the root's mount", async () => {
    const root = await settledTree();
    const read: string[] = [];
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: () => mountedTable(root),
      readDescriptorInfo: (entry, fd) => {
        read.push(path.relative(root, path.resolve(entry)));
        return fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      },
    });
    expect(result.status).toBe("removed");
    expect(read).toEqual(
      expect.arrayContaining(["", "nested", "top.txt", "nested/kept.txt"]),
    );
  });

  it("reads no entry's mount id when nothing is mounted at or under the tree", async () => {
    const root = await settledTree();
    const real = await fs.realpath(root);
    const read: string[] = [];
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: async () =>
        `${mountLine("/")}${mountLine(`${real}-sibling`)}${mountLine(path.dirname(real))}`,
      readDescriptorInfo: (entry, fd) => {
        read.push(path.relative(root, path.resolve(entry)));
        return fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      },
    });
    expect(result.status).toBe("removed");
    expect(read.sort()).toEqual(["", ".."]);
  });

  it.each([
    ["cannot be read", () => Promise.reject(new Error("EACCES"))],
    ["lists no mounts", () => Promise.resolve("")],
    [
      "has a line without a mount point",
      () => Promise.resolve("36 1 0:51 /\n"),
    ],
    [
      "has a row whose fields are shifted by an extra space",
      async () =>
        `${mountLine("/")}36 1 0:51  / /unrelated rw - tmpfs none rw\n`,
    ],
    [
      "has a row without its separator",
      async () => `${mountLine("/")}36 1 0:51 / /unrelated rw tmpfs none rw\n`,
    ],
    [
      "has a row with a non-numeric mount id",
      async () =>
        `${mountLine("/")}x6 1 0:51 / /unrelated rw - tmpfs none rw\n`,
    ],
  ])(
    "checks each entry's mount id when the mount table %s",
    async (_label, table) => {
      const root = await settledTree();
      const nested = path.join(root, "nested");
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readMountTable: table,
        readDescriptorInfo: async (entry, fd) => {
          const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
          return path.resolve(entry) === nested ? shifted(info) : info;
        },
      });
      expect(result).toMatchObject({
        status: "retained",
        mountedPaths: [nested],
      });
      await expect(
        fs.readFile(path.join(nested, "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    },
  );

  it("reads no entry's mount id when only an nsfs bind outside the tree is listed", async () => {
    const root = await settledTree();
    const read: string[] = [];
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: async () =>
        `${mountLine("/")}612 30 0:4 net:[4026531840] /run/netns/x rw shared:5 - nsfs nsfs rw\n`,
      readDescriptorInfo: (entry, fd) => {
        read.push(path.relative(root, path.resolve(entry)));
        return fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
      },
    });
    expect(result.status).toBe("removed");
    expect(read.sort()).toEqual(["", ".."]);
  });

  it("checks each entry's mount id when an nsfs bind is listed under the tree", async () => {
    const root = await settledTree();
    const nested = path.join(root, "nested");
    const real = await fs.realpath(root);
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      readMountTable: async () =>
        `${mountLine("/")}612 30 0:4 net:[4026531840] ${real}/nested rw shared:5 - nsfs nsfs rw\n`,
      readDescriptorInfo: async (entry, fd) => {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
        return path.resolve(entry) === nested ? shifted(info) : info;
      },
    });
    expect(result).toMatchObject({
      status: "retained",
      mountedPaths: [nested],
    });
  });

  it.each([
    [
      "under the tree, with escaped characters in its path",
      "tree with\tspaces",
      "nested",
    ],
    ["at the tree's root", "tree", ""],
  ])(
    "checks each entry's mount id when the mount table lists a mount %s",
    async (_label, name, mounted) => {
      const root = await settledTree(name);
      const nested = path.join(root, "nested");
      const real = await fs.realpath(root);
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readMountTable: async () =>
          `${mountLine("/")}${mountLine(path.join(real, mounted))}`,
        readDescriptorInfo: async (entry, fd) => {
          const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
          return path.resolve(entry) === nested ? shifted(info) : info;
        },
      });
      expect(result).toMatchObject({
        status: "retained",
        mountedPaths: [nested],
      });
      await expect(
        fs.readFile(path.join(nested, "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    },
  );
});

async function inMountNamespace(
  mount: string,
  mountArgs: readonly string[],
  script: string,
  scriptArgs: readonly string[],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--mount",
        "sh",
        "-c",
        `${mount} && shift ${mountArgs.length} && exec "$@"`,
        "sh",
        ...mountArgs,
        process.execPath,
        "--input-type=module",
        "-e",
        script,
        modulePath,
        ...scriptArgs,
      ],
      (error, out, stderr) =>
        error === null
          ? resolve(out)
          : reject(new Error(`${error.message}\n${stderr}`)),
    );
  });
}

const inspectMountedTree = `
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { inspectTreeBeforeMove } = await import(process.argv[1]);
const [root, mounted] = process.argv.slice(2);
await fs.writeFile(path.join(mounted, "inside.txt"), "inside\\n");
const info = await fs.lstat(root);
const inspection = await inspectTreeBeforeMove(root, Number.MAX_SAFE_INTEGER, {
  rootMetadata: { ctimeMs: info.ctimeMs, mtimeMs: info.mtimeMs },
});
process.stdout.write(JSON.stringify(inspection));
`;

const inspectMoveAndRemove = `
const fs = await import("node:fs/promises");
const { inspectTreeBeforeMove, removeDirectoryTree, treeFingerprint } = await import(process.argv[1]);
const [root, trashEntry] = process.argv.slice(2);
const info = await fs.lstat(root);
const inspection = await inspectTreeBeforeMove(root, Number.MAX_SAFE_INTEGER, {
  rootMetadata: { ctimeMs: info.ctimeMs, mtimeMs: info.mtimeMs },
});
await fs.rename(root, trashEntry);
const moved = await treeFingerprint(trashEntry);
const removal = await removeDirectoryTree(trashEntry, {
  startedAt: Number.MAX_SAFE_INTEGER,
});
process.stdout.write(JSON.stringify({ inspection, moved, removal }));
`;

describe.runIf(linux)("inspecting a tree before a move to the trash", () => {
  it.runIf(linux && mountNamespacesAvailable())(
    "reports a real tmpfs mounted inside the tree, which has its own device as every macOS mount does",
    async () => {
      const root = await settledTree();
      const mounted = path.join(root, "nested", "mounted");
      await fs.mkdir(mounted);
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      const inspection = JSON.parse(
        await inMountNamespace(
          'mount -t tmpfs none "$1"',
          [mounted],
          inspectMountedTree,
          [root, mounted],
        ),
      );
      expect(inspection).toEqual({
        changed: false,
        mountedPaths: [mounted],
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      });
    },
  );

  it.runIf(linux && mountNamespacesAvailable())(
    "cannot see a same-device bind mount by device, so removing the moved trash entry finds it and keeps the bind source whole",
    async () => {
      const { source, root } = await boundTree();
      const trash = path.join(path.dirname(root), ".trash");
      await fs.mkdir(trash);
      const trashEntry = path.join(trash, "tree-entry");
      const bound = path.join(root, "sub", "child");
      const { inspection, moved, removal } = JSON.parse(
        await inMountNamespace(
          'mount --bind "$1" "$2"',
          [source, bound],
          inspectMoveAndRemove,
          [root, trashEntry],
        ),
      );
      expect(inspection).toEqual({
        changed: false,
        mountedPaths: [],
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/u),
      });
      expect(moved).toBe(inspection.fingerprint);
      expect(removal.status).toBe("retained");
      expect(removal.mountedPaths.length).toBeGreaterThan(0);
      await expect(
        fs.readFile(path.join(source, "a.txt"), "utf8"),
      ).resolves.toBe("keep\n");
      await expect(
        fs.readFile(path.join(source, "nested", "b.txt"), "utf8"),
      ).resolves.toBe("keep too\n");
      expect(existsSync(root)).toBe(false);
      expect(
        (await fs.lstat(path.join(trashEntry, "sub", "child"))).isDirectory(),
      ).toBe(true);
    },
  );
});

describe.runIf(process.platform === "darwin")(
  "removing a tree on macOS",
  () => {
    it("never reads descriptor info", async () => {
      const root = await settledTree();
      let reads = 0;
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readDescriptorInfo: async () => {
          reads += 1;
          return "";
        },
      });
      expect(result.status).toBe("removed");
      expect(reads).toBe(0);
    });

    it("never pins a .git swapped for a FIFO just before the held-marker open, and keeps the tree", async () => {
      const root = await settledTree();
      const marker = path.join(root, ".git");
      await fs.writeFile(marker, "gitdir: /nowhere\n");
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      let swapped = "";
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        beforeMarkerOpen: async (candidate) => {
          if (swapped !== "") return;
          const anchor = await fs.stat(path.dirname(candidate));
          for (const name of await fs.readdir(path.dirname(root))) {
            const info = await fs.lstat(path.join(path.dirname(root), name));
            if (info.ino === anchor.ino && info.dev === anchor.dev)
              swapped = path.join(path.dirname(root), name, ".git");
          }
          await swapForFifo(swapped);
        },
      }).catch((error: unknown) => ({ thrown: String(error) }));
      expect(swapped).not.toBe("");
      expect(result).toMatchObject({ status: "retained" });
      expect((await fs.lstat(marker)).isFIFO()).toBe(true);
    });
  },
);

async function swapForFifo(real: string): Promise<void> {
  await fs.rm(real);
  execFileSync("mkfifo", [real]);
}

async function settleOrRelease(
  removal: Promise<unknown>,
  fifo: () => string,
): Promise<{ hung: boolean; outcome: unknown }> {
  const outcome = await Promise.race([
    removal,
    delay(3_000).then(() => "hung" as const),
  ]);
  if (outcome !== "hung") return { hung: false, outcome };
  const releaser = spawn("sh", ["-c", 'exec 3>"$1"; sleep 1', "sh", fifo()], {
    stdio: "ignore",
  });
  await removal;
  releaser.kill();
  return { hung: true, outcome };
}

function realEntry(root: string, candidate: string): string {
  const rest = /^\/(?:proc\/self\/fd\/\d+|\.vol\/\d+\/\d+)\/(.+)$/u.exec(
    candidate,
  )?.[1];
  if (rest === undefined) return candidate;
  const first = rest.split("/")[0] ?? "";
  return first === path.basename(root) || first.startsWith(".bb-removing-")
    ? path.join(path.dirname(root), rest)
    : path.join(root, rest);
}

describe("opening a file swapped for a FIFO during removal", () => {
  it("keeps a regular file swapped for a FIFO just before its open, without blocking", async () => {
    const root = await settledTree();
    const top = path.join(root, "top.txt");
    let swapped = "";
    const started = performance.now();
    const { hung, outcome } = await settleOrRelease(
      removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        beforeFileOpen: async (candidate) => {
          if (swapped !== "" || realEntry(root, candidate) !== top) return;
          await swapForFifo(top);
          swapped = top;
        },
      }).catch((error: unknown) => ({ thrown: String(error) })),
      () => top,
    );
    expect(swapped).toBe(top);
    expect(hung).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(outcome).toMatchObject({ status: "retained" });
    expect((await fs.lstat(top)).isFIFO()).toBe(true);
  }, 10_000);

  it("never accepts a pinned .git marker swapped for an empty FIFO just before its contents are verified, and never blocks", async () => {
    const root = await settledTree();
    await fs.writeFile(path.join(root, ".git"), "");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let swapped = "";
    const started = performance.now();
    const { hung, outcome } = await settleOrRelease(
      removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        beforeFileOpen: async (candidate) => {
          if (
            swapped !== "" ||
            !path.basename(candidate).startsWith(".bb-pin-")
          )
            return;
          const real = realEntry(root, candidate);
          await swapForFifo(real);
          swapped = real;
        },
      }).catch((error: unknown) => ({ thrown: String(error) })),
      () => swapped,
    );
    expect(swapped).not.toBe("");
    expect(hung).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(outcome).not.toMatchObject({ status: "removed" });
    const fifos = (
      await fs.readdir(path.dirname(root), {
        recursive: true,
        withFileTypes: true,
      })
    ).filter((entry) => entry.isFIFO());
    expect(fifos.length).toBeGreaterThan(0);
  }, 10_000);
});

function fuseOverlayAvailable(): boolean {
  if (!existsSync("/dev/fuse")) return false;
  try {
    execFileSync("fuse-overlayfs", ["--version"], { stdio: "ignore" });
    execFileSync("fusermount3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function fuseMountsUnder(parent: string): Promise<string[]> {
  const table = await fs.readFile("/proc/self/mountinfo", "utf8");
  return table
    .split("\n")
    .map((line) => line.split(" "))
    .filter(
      (fields) =>
        fields[4]?.startsWith(`${parent}/`) === true &&
        fields.includes("fuse.fuse-overlayfs"),
    )
    .map((fields) => fields[4] ?? "");
}

describe.runIf(linux)("a FUSE mount already inside the tree", () => {
  it("keeps a directory on a FUSE mount without sending it an open", async (context) => {
    if (!fuseOverlayAvailable()) context.skip();
    const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-fuse-"));
    roots.push(parent);
    const lower = path.join(parent, "lower");
    const root = path.join(parent, "tree");
    const mounted = path.join(root, "mounted");
    await fs.mkdir(path.join(lower, "sub"), { recursive: true });
    await fs.writeFile(path.join(lower, "sub", "kept.txt"), "kept\n");
    await fs.mkdir(path.join(parent, "upper"));
    await fs.mkdir(path.join(parent, "work"));
    await fs.mkdir(mounted, { recursive: true });
    await fs.writeFile(path.join(root, "top.txt"), "top\n");
    const log = path.join(parent, "requests.log");
    const logFile = await fs.open(log, "w");
    const daemon = spawn(
      "fuse-overlayfs",
      [
        "-f",
        "-d",
        "-o",
        `lowerdir=${lower},upperdir=${path.join(parent, "upper")},workdir=${path.join(parent, "work")}`,
        mounted,
      ],
      { stdio: ["ignore", "ignore", logFile.fd] },
    );
    await logFile.close();
    try {
      for (let wait = 0; (await fuseMountsUnder(parent)).length === 0; wait++) {
        if (wait === 400)
          throw new Error(
            `FUSE mount never appeared\n${await fs.readFile(log, "utf8")}`,
          );
        await delay(50);
      }
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      const opensBefore =
        (await fs.readFile(log, "utf8")).match(/\bOPENDIR\b/gu)?.length ?? 0;
      const outcome = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
      });
      await delay(100);
      const requests = await fs.readFile(log, "utf8");
      expect(requests).toMatch(/\bINIT\b/u);
      expect(requests.match(/\bOPENDIR\b/gu)?.length ?? 0).toBe(opensBefore);
      expect(outcome).toMatchObject({ status: "retained" });
      expect(outcome.mountedPaths).toContain(mounted);
      await expect(
        fs.readFile(path.join(lower, "sub", "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    } finally {
      for (const point of await fuseMountsUnder(parent))
        await new Promise((resolve) =>
          execFile("fusermount3", ["-u", point], resolve),
        );
      daemon.kill();
    }
  }, 60_000);

  it("never sends an open to a FUSE directory bound into a tree on the same FUSE mount", async (context) => {
    if (!fuseOverlayAvailable() || !mountNamespacesAvailable()) context.skip();
    const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-fuse-bind-"));
    roots.push(parent);
    const lower = path.join(parent, "lower");
    await fs.mkdir(path.join(lower, "tree", "mounted"), { recursive: true });
    await fs.mkdir(path.join(lower, "other", "x"), { recursive: true });
    await fs.writeFile(path.join(lower, "other", "x", "kept.txt"), "kept\n");
    await fs.writeFile(path.join(lower, "tree", "top.txt"), "top\n");
    await fs.mkdir(path.join(parent, "upper"));
    await fs.mkdir(path.join(parent, "work"));
    await fs.mkdir(path.join(parent, "merged"));
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const log = path.join(parent, "requests.log");
    const merged = path.join(parent, "merged");
    const script = [
      'fuse-overlayfs -f -d -o "lowerdir=$1,upperdir=$2,workdir=$3" "$4" 2>"$5" & daemon=$!',
      "tries=0",
      'until grep -q " $4 " /proc/self/mountinfo; do tries=$((tries + 1)); [ "$tries" -gt 100 ] && exit 3; sleep 0.05; done',
      'mount --bind "$4/other" "$4/tree/mounted" || { kill "$daemon"; exit 4; }',
      'test -e "$4/tree/mounted/.bb-fuse-probe"',
      '"$6" --input-type=module -e "$7" "$8" "$4/tree" > "$9"; status=$?',
      'umount "$4/tree/mounted"; umount "$4" || kill "$daemon"; wait "$daemon"',
      'exit "$status"',
    ].join("\n");
    const output = path.join(parent, "result.json");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "unshare",
        [
          "--user",
          "--map-root-user",
          "--mount",
          "sh",
          "-c",
          script,
          "sh",
          lower,
          path.join(parent, "upper"),
          path.join(parent, "work"),
          merged,
          log,
          process.execPath,
          runRemoval,
          modulePath,
          output,
        ],
        { timeout: 50_000 },
        (error, _out, stderr) =>
          error === null
            ? resolve()
            : reject(new Error(`${error.message}\n${stderr}`)),
      );
    });
    const requests = await fs.readFile(log, "utf8");
    const probed = /ovl_lookup\(parent=(\d+), name=\.bb-fuse-probe\)/u.exec(
      requests,
    )?.[1];
    expect(probed).toBeDefined();
    expect(requests).toMatch(/opcode: OPENDIR \(27\)/u);
    expect(requests).not.toMatch(
      new RegExp(`opcode: OPENDIR \\(27\\), nodeid: ${probed},`, "u"),
    );
    const removal = JSON.parse(await fs.readFile(output, "utf8")) as {
      value?: RemoveDirectoryTreeResult;
      thrown?: string;
    };
    expect(removal.thrown).toBeUndefined();
    expect(removal.value).toMatchObject({ status: "retained" });
    expect(removal.value?.mountedPaths).toContain(
      path.join(merged, "tree", "mounted"),
    );
    expect(existsSync(path.join(parent, "upper", "other"))).toBe(false);
    await expect(
      fs.readFile(path.join(lower, "other", "x", "kept.txt"), "utf8"),
    ).resolves.toBe("kept\n");
  }, 60_000);
});

describe.runIf(linux)(
  "never opening a FIFO swapped in before a checked open",
  () => {
    it.each([
      [
        "the per-file open",
        false,
        (root: string, candidate: string) =>
          realEntry(root, candidate) === path.join(root, "top.txt"),
      ],
      [
        "the recovery open",
        true,
        (_root: string, candidate: string) =>
          path.basename(candidate).startsWith(".bb-pin-"),
      ],
    ])(
      "never opens a file swapped for a FIFO just before %s, and keeps it",
      async (_label, withMarker, swapsAt) => {
        const root = await settledTree();
        if (withMarker) {
          await fs.writeFile(path.join(root, ".git"), "");
          await delay(FILE_TIMESTAMP_LAG_MS + 50);
        }
        const opened = path.join(path.dirname(root), "opened");
        let writer: ChildProcess | undefined;
        let swapped = "";
        const started = performance.now();
        const outcome = await removeDirectoryTree(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          beforeFileOpen: async (candidate) => {
            if (writer !== undefined || !swapsAt(root, candidate)) return;
            swapped = realEntry(root, candidate);
            await swapForFifo(swapped);
            writer = spawn(
              "sh",
              ["-c", 'exec 3>"$1"; echo opened > "$2"', "sh", swapped, opened],
              { stdio: "ignore" },
            );
            await delay(100);
          },
        }).catch((error: unknown) => ({ thrown: String(error) }));
        await delay(200);
        const writerWaiting = writer?.exitCode === null;
        writer?.kill();
        expect(swapped).not.toBe("");
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(existsSync(opened)).toBe(false);
        expect(writerWaiting).toBe(true);
        expect(outcome).not.toMatchObject({ status: "removed" });
      },
      10_000,
    );
  },
);

describe.runIf(linux)("reopening the held .git marker", () => {
  it("closes the reopened marker and keeps the tree when its stat fails", async () => {
    const root = await settledTree();
    const marker = path.join(root, ".git");
    await fs.writeFile(marker, "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let reopened: RemoveTreeFileHandle | undefined;
    const result = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      afterMarkerReopen: async (handle) => {
        reopened = handle;
        throw Object.assign(new Error("stat failed"), { code: "EIO" });
      },
    });
    expect(reopened).toBeDefined();
    expect(reopened?.fd).toBe(-1);
    expect(result).toMatchObject({ status: "retained" });
    await expect(fs.readFile(marker, "utf8")).resolves.toBe(
      "gitdir: /nowhere\n",
    );
  });
});

async function stillLinked(
  directory: string,
  original: { dev: number; ino: number },
): Promise<boolean> {
  for (const entry of await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const info = await fs.lstat(path.join(entry.parentPath, entry.name));
    if (
      info.dev === original.dev &&
      info.ino === original.ino &&
      !entry.name.startsWith(".bb-removing-")
    )
      return true;
  }
  return false;
}

async function forcedRestore(
  root: string,
  target: string,
  swapAt: (candidate: string, opens: number) => boolean,
  occupy?: string,
  readDescriptorInfo?: (entry: string, fd: number) => Promise<string>,
) {
  const content = await fs.readFile(target, "utf8");
  let opens = 0;
  let swapped = "";
  const outcome = await removeDirectoryTree(root, {
    startedAt: Number.MAX_SAFE_INTEGER,
    ...(readDescriptorInfo === undefined
      ? {}
      : {
          readDescriptorInfo,
          readMountTable: () => mountedTable(root),
        }),
    afterEntryQuarantined: async (removed) => {
      if (path.basename(removed) !== "top.txt") return;
      if (occupy !== undefined) await fs.writeFile(removed, occupy);
      throw new Error("force a restore");
    },
    beforeFileOpen: async (candidate) => {
      if (swapped !== "") return;
      opens += 1;
      if (!swapAt(candidate, opens)) return;
      const real = realEntry(root, candidate);
      await fs.rm(real);
      await fs.writeFile(real, content);
      swapped = real;
    },
  }).catch((error: unknown) => ({ thrown: String(error) }));
  return { outcome, swapped };
}

describe("verifying a recovered file", () => {
  it("never accepts a same-content file swapped in for an entry restored to its own name", async () => {
    const root = await settledTree();
    const top = path.join(root, "top.txt");
    const original = await fs.stat(top);
    let topOpens = 0;
    const { outcome, swapped } = await forcedRestore(root, top, (candidate) => {
      if (realEntry(root, candidate) !== top) return false;
      topOpens += 1;
      return topOpens === 2;
    });
    expect(swapped).toBe(top);
    expect(outcome).not.toMatchObject({ status: "removed" });
    expect(await stillLinked(path.dirname(root), original)).toBe(true);
  });

  it("never accepts a same-content file swapped in for an entry restored under a recovery name", async () => {
    const root = await settledTree();
    const top = path.join(root, "top.txt");
    const original = await fs.stat(top);
    const { outcome, swapped } = await forcedRestore(
      root,
      top,
      (candidate) => path.basename(candidate).includes(".bb-recovered-"),
      "occupied\n",
    );
    expect(swapped).not.toBe("");
    expect(outcome).not.toMatchObject({ status: "removed" });
    expect(await stillLinked(path.dirname(root), original)).toBe(true);
  });

  it("never accepts a same-content file swapped in for the restored .git marker", async () => {
    const root = await settledTree();
    const marker = path.join(root, ".git");
    await fs.writeFile(marker, "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const original = await fs.stat(marker);
    let swapped = "";
    const outcome = await removeDirectoryTree(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      afterRootMarkerDetached: async (quarantined) => {
        await fs.writeFile(path.join(quarantined, "late.txt"), "late\n");
      },
      beforeFileOpen: async (candidate) => {
        if (swapped !== "" || path.basename(candidate) !== ".git") return;
        const real = realEntry(root, candidate);
        await fs.rm(real);
        await fs.writeFile(real, "gitdir: /nowhere\n");
        swapped = real;
      },
    }).catch((error: unknown) => ({ thrown: String(error) }));
    expect(swapped).not.toBe("");
    expect(outcome).not.toMatchObject({ status: "removed" });
    expect(await stillLinked(path.dirname(root), original)).toBe(true);
  });

  it.runIf(linux)(
    "never accepts an entry restored to its own name whose descriptor is on another mount",
    async () => {
      const root = await settledTree();
      const top = path.join(root, "top.txt");
      const original = await fs.stat(top);
      let topReads = 0;
      let shiftedReads = 0;
      const { outcome } = await forcedRestore(
        root,
        top,
        () => false,
        undefined,
        async (entry, fd) => {
          const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
          if (path.basename(entry) !== "top.txt") return info;
          topReads += 1;
          if (topReads !== 2) return info;
          shiftedReads += 1;
          return info.replace(
            /^mnt_id:\s*(\d+)$/mu,
            (_line, id: string) => `mnt_id:\t${Number(id) + 1}`,
          );
        },
      );
      expect(shiftedReads).toBe(1);
      expect(outcome).not.toMatchObject({ status: "removed" });
      expect(await stillLinked(path.dirname(root), original)).toBe(true);
    },
  );
});
