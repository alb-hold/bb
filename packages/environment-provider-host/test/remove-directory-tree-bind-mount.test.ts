import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TIMESTAMP_LAG_MS,
  keptTreeReasons,
  removeDirectoryTree,
  type RemoveDirectoryTreeResult,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];
const modulePath = path.resolve(
  import.meta.dirname,
  "../src/remove-directory-tree.ts",
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

async function settledTree() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-mount-id-"));
  roots.push(parent);
  const root = path.join(parent, "tree");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "nested", "kept.txt"), "kept\n");
  await fs.writeFile(path.join(root, "top.txt"), "top\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return root;
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

describe.runIf(linux)("reopening the held .git marker", () => {
  it("closes the reopened marker and keeps the tree when its stat fails", async () => {
    const root = await settledTree();
    const marker = path.join(root, ".git");
    await fs.writeFile(marker, "gitdir: /nowhere\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let reopened: FileHandle | undefined;
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
    ...(readDescriptorInfo === undefined ? {} : { readDescriptorInfo }),
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
