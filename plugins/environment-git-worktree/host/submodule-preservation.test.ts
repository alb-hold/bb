import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync, fstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import type {
  DirectoryEntry,
  DirectoryListing,
  RepositoryScanHooks,
} from "./repository-detection.js";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const asRoot = process.getuid?.() === 0;
const GIT_CONFIG = [
  "-c",
  "protocol.file.allow=always",
  "-c",
  "user.name=Submodule Test",
  "-c",
  "user.email=submodule-test@example.invalid",
  "-c",
  "init.defaultBranch=main",
];

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", recordUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", recordUnhandled);
});
afterEach(() => {
  expect(unhandled.splice(0)).toEqual([]);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await execFile("chmod", ["-R", "u+rwx", root]).catch(() => undefined);
    await execFile("rm", ["-rf", root]);
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", [...GIT_CONFIG, ...args], { cwd });
  return result.stdout;
}

interface Fixture {
  root: string;
  outside: string;
  path: string;
  gitDir: string;
}

async function repository(directory: string, file = "f"): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  await git(directory, "init");
  await fs.writeFile(path.join(directory, file), `${file}\n`);
  await git(directory, "add", file);
  await git(directory, "commit", "-m", file);
  return (await git(directory, "rev-parse", "HEAD")).trim();
}

async function fixture(
  options: {
    submodule?: "initialized" | "uninitialized";
    nestedSubmodule?: boolean;
    submodulePath?: string;
    ignore?: string;
  } = {},
): Promise<Fixture> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-submodule-")),
  );
  roots.push(base);
  const root = path.join(base, "managed");
  const outside = path.join(base, "outside");
  const source = path.join(base, "source");
  const bare = path.join(base, "remote.git");
  const workspace = path.join(root, "repo");
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
  await git(base, "init", "--bare", bare);
  await git(base, "init", source);
  await fs.writeFile(path.join(source, "README.md"), "published\n");
  await fs.writeFile(
    path.join(source, ".gitignore"),
    `.env\nnode_modules/\n${options.ignore ?? ""}`,
  );
  await git(source, "add", "README.md", ".gitignore");
  await git(source, "commit", "-m", "published");
  if (options.submodule !== undefined) {
    const subSource = path.join(base, "sub-source");
    const subBare = path.join(base, "sub.git");
    await repository(subSource);
    await fs.writeFile(path.join(subSource, ".gitignore"), ".env\n");
    await git(subSource, "add", ".gitignore");
    if (options.nestedSubmodule === true) {
      const nestedBare = path.join(base, "nested.git");
      await repository(path.join(base, "nested-source"));
      await git(base, "clone", "--bare", "nested-source", nestedBare);
      await git(subSource, "submodule", "add", nestedBare, "nested");
    }
    await git(subSource, "commit", "-m", "sub");
    await git(base, "clone", "--bare", subSource, subBare);
    await git(
      source,
      "submodule",
      "add",
      subBare,
      options.submodulePath ?? "sub",
    );
    await git(source, "commit", "-m", "add submodule");
  }
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "--set-upstream", "origin", "main");
  await git(source, "worktree", "add", "-b", "feature", workspace);
  await git(workspace, "push", "--set-upstream", "origin", "feature");
  if (options.submodule === "initialized")
    await git(workspace, "submodule", "update", "--init");
  const gitDir = (
    await git(workspace, "rev-parse", "--absolute-git-dir")
  ).trim();
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { root, outside, path: workspace, gitDir };
}

async function settle(): Promise<void> {
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
}

type Hooks = NonNullable<Parameters<typeof removeWorktree>[0]["testHooks"]>;

async function removal(
  worktree: Fixture,
  testHooks?: Hooks,
): Promise<string[] | "removed"> {
  try {
    await removeWorktree({
      path: worktree.path,
      rootPath: worktree.root,
      trashRoot: path.join(worktree.root, "..", ".trash"),
      ...(testHooks !== undefined ? { testHooks } : {}),
    });
    return "removed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^Kept [^:]+: (.*)\. Commit and push the work/su.exec(
      message,
    );
    if (match?.[1] === undefined) throw error;
    return match[1].split("; ");
  }
}

function unknownType(name: string): DirectoryEntry {
  const no = () => false;
  return {
    name,
    isDirectory: no,
    isFile: no,
    isSymbolicLink: no,
    isFIFO: no,
    isSocket: no,
    isCharacterDevice: no,
    isBlockDevice: no,
  };
}

async function listed(
  directory: string,
  map: (entry: DirectoryEntry) => DirectoryEntry = (entry) => entry,
): Promise<DirectoryListing> {
  const dir = await fs.opendir(directory);
  return {
    async *[Symbol.asyncIterator]() {
      for await (const entry of dir) yield map(entry);
    },
    close: () => dir.close(),
  };
}

function scan(hooks: RepositoryScanHooks): Hooks {
  return { repositoryScan: hooks };
}

const MODULES = (names: string) =>
  `has submodule repositories in its Git metadata (${names}), and removing the worktree would delete them with any unpushed commits`;
const INITIALIZED = (gitlink: string) =>
  `has an initialized submodule at ${gitlink}, whose files would be deleted with the worktree`;
const INSIDE = (gitlink: string) =>
  `has a submodule at ${gitlink} whose repository is inside the worktree (${gitlink}/.git) and would be deleted with it`;
const NESTED = (paths: string) =>
  `has a git repository inside the worktree at ${paths}`;
const UNFINISHED =
  "could not finish checking for git repositories inside the worktree (";

async function objectExists(gitDir: string, sha: string): Promise<boolean> {
  const result = spawnSync("git", ["--git-dir", gitDir, "cat-file", "-e", sha]);
  return result.status === 0;
}

const supported = process.platform === "linux" || process.platform === "darwin";

describe.runIf(supported)("removing a worktree with submodules", () => {
  it("keeps a clean worktree with an initialized submodule, naming its repository and checkout", async () => {
    const worktree = await fixture({ submodule: "initialized" });
    await expect(removal(worktree)).resolves.toEqual([
      MODULES("modules/sub"),
      INITIALIZED("sub"),
    ]);
    expect(
      existsSync(path.join(worktree.gitDir, "modules", "sub", "HEAD")),
    ).toBe(true);
  });

  it("keeps a worktree whose submodule holds an ignored .env", async () => {
    const worktree = await fixture({ submodule: "initialized" });
    await fs.writeFile(path.join(worktree.path, "sub", ".env"), "SECRET=1\n");
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      MODULES("modules/sub"),
      INITIALIZED("sub"),
    ]);
    await expect(
      fs.readFile(path.join(worktree.path, "sub", ".env"), "utf8"),
    ).resolves.toBe("SECRET=1\n");
  });

  it("keeps a deinitialized submodule's repository with its unpublished commit", async () => {
    const worktree = await fixture({ submodule: "initialized" });
    const sub = path.join(worktree.path, "sub");
    await fs.writeFile(path.join(sub, "g"), "unpublished\n");
    await git(sub, "add", "g");
    await git(sub, "commit", "-m", "unpublished");
    const commit = (await git(sub, "rev-parse", "HEAD")).trim();
    await git(worktree.path, "add", "sub");
    await git(worktree.path, "commit", "-m", "bump");
    await git(worktree.path, "push");
    await git(worktree.path, "submodule", "deinit", "-f", "sub");
    await settle();
    await expect(removal(worktree)).resolves.toEqual([MODULES("modules/sub")]);
    expect(
      await objectExists(path.join(worktree.gitDir, "modules", "sub"), commit),
    ).toBe(true);
  });

  it("keeps a submodule repository left behind after its gitlink is removed", async () => {
    const worktree = await fixture({ submodule: "initialized" });
    await git(worktree.path, "rm", "-q", "sub");
    await git(worktree.path, "commit", "-m", "drop sub");
    await git(worktree.path, "push");
    await settle();
    await expect(removal(worktree)).resolves.toEqual([MODULES("modules/sub")]);
  });

  it("keeps a skip-worktree gitlink whose checkout is gone, by its module repository", async () => {
    const worktree = await fixture({ submodule: "initialized" });
    await git(worktree.path, "update-index", "--skip-worktree", "sub");
    await fs.rm(path.join(worktree.path, "sub"), {
      recursive: true,
      force: true,
    });
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      MODULES("modules/sub"),
      "has files marked assume-unchanged or skip-worktree",
    ]);
  });

  it("keeps a submodule whose own nested submodule was never initialized", async () => {
    const worktree = await fixture({
      submodule: "initialized",
      nestedSubmodule: true,
    });
    expect(existsSync(path.join(worktree.path, "sub", "nested", ".git"))).toBe(
      false,
    );
    await expect(removal(worktree)).resolves.toEqual([
      MODULES("modules/sub"),
      INITIALIZED("sub"),
    ]);
  });

  it("keeps an unabsorbed submodule whose only copy of a commit is inside the worktree", async () => {
    const worktree = await fixture();
    const inner = path.join(worktree.path, "inner");
    const commit = await repository(inner);
    await git(worktree.path, "add", "inner");
    await git(worktree.path, "commit", "-m", "inner");
    await git(worktree.path, "push");
    await settle();
    await expect(removal(worktree)).resolves.toEqual([INSIDE("inner")]);
    expect(await objectExists(path.join(inner, ".git"), commit)).toBe(true);
  });

  it.skipIf(asRoot)("keeps a worktree whose index cannot be read", async () => {
    const worktree = await fixture({ submodule: "uninitialized" });
    await fs.chmod(path.join(worktree.gitDir, "index"), 0o000);
    const reasons = await removal(worktree);
    expect(reasons).not.toBe("removed");
    expect(
      (reasons as string[]).filter((reason) =>
        reason.startsWith("could not read its index to look for submodules ("),
      ),
    ).toHaveLength(1);
  });

  it.skipIf(asRoot)(
    "keeps a worktree whose modules directory cannot be read, and its module repository",
    async () => {
      const worktree = await fixture({ submodule: "initialized" });
      const modules = path.join(worktree.gitDir, "modules");
      await fs.chmod(modules, 0o000);
      const reasons = await removal(worktree);
      await fs.chmod(modules, 0o755);
      expect(reasons).not.toBe("removed");
      expect(
        (reasons as string[]).filter((reason) =>
          reason.startsWith(
            "could not check for submodule repositories (EACCES",
          ),
        ),
      ).toHaveLength(1);
      expect(existsSync(path.join(modules, "sub", "HEAD"))).toBe(true);
    },
  );

  it("keeps a worktree whose modules entry is a symbolic link, without listing its target", async () => {
    const worktree = await fixture();
    const target = path.join(worktree.outside, "modules");
    await fs.mkdir(path.join(target, "elsewhere"), { recursive: true });
    await fs.symlink(target, path.join(worktree.gitDir, "modules"));
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      "has a modules entry in its Git metadata that is a symbolic link, not a directory",
    ]);
    expect(existsSync(path.join(target, "elsewhere"))).toBe(true);
  });

  it("keeps a worktree whose gitlink path passes through a symbolic link", async () => {
    const worktree = await fixture({
      submodule: "initialized",
      submodulePath: "libs/sub",
    });
    const moved = path.join(worktree.outside, "libs");
    await fs.rename(path.join(worktree.path, "libs"), moved);
    await fs.symlink(moved, path.join(worktree.path, "libs"));
    await settle();
    const reasons = await removal(worktree);
    expect(reasons).toContain(
      "has a submodule path libs/sub that passes through a symbolic link",
    );
    expect(existsSync(path.join(moved, "sub", ".git"))).toBe(true);
  });

  it("keeps an ignored repository that is not a gitlink through the ignored-file rule", async () => {
    const worktree = await fixture({ ignore: "vendor/\n" });
    await repository(path.join(worktree.path, "vendor", "x"));
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      NESTED("vendor/x"),
      "has uncommitted changes or untracked files",
    ]);
  });

  it("removes a worktree whose only submodule was never initialized", async () => {
    const worktree = await fixture({ submodule: "uninitialized" });
    await expect(removal(worktree)).resolves.toBe("removed");
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("removes a worktree whose modules directory is empty", async () => {
    const worktree = await fixture({ submodule: "uninitialized" });
    await fs.mkdir(path.join(worktree.gitDir, "modules"));
    await settle();
    await expect(removal(worktree)).resolves.toBe("removed");
  });

  it("catches in the final pass a submodule initialized after the first pass, without a Git status error", async () => {
    const worktree = await fixture({ submodule: "uninitialized" });
    const reasons = await removal(worktree, {
      afterFinalBaseline: async (worktreePath) => {
        await git(worktreePath, "submodule", "update", "--init");
      },
    });
    expect(reasons).toEqual([MODULES("modules/sub"), INITIALIZED("sub")]);
  });

  it("catches in the final pass a module repository created after the first pass", async () => {
    const worktree = await fixture();
    const reasons = await removal(worktree, {
      afterFinalBaseline: async (_worktreePath, gitDir) => {
        await fs.mkdir(path.join(gitDir, "modules", "late"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(gitDir, "modules", "late", "HEAD"),
          "ref: refs/heads/main\n",
        );
      },
    });
    expect(reasons).toEqual([MODULES("modules/late")]);
  });

  it.each([
    ["node_modules/y", "node_modules/y"],
    ["node_modules/@s/y", "node_modules/@s/y"],
  ])(
    "keeps a repository at %s whose only commit is inside the worktree",
    async (relative, named) => {
      const worktree = await fixture();
      const commit = await repository(path.join(worktree.path, relative));
      await settle();
      await expect(removal(worktree)).resolves.toEqual([NESTED(named)]);
      expect(
        await objectExists(path.join(worktree.path, relative, ".git"), commit),
      ).toBe(true);
    },
  );

  it("walks into entries whose type the file system does not report, and finds a repository below them", async () => {
    const worktree = await fixture();
    await repository(path.join(worktree.path, "node_modules", "pkg", "y"));
    await settle();
    const reasons = await removal(
      worktree,
      scan({
        openDirectoryEntries: async (directory, entry) =>
          listed(directory, ({ name }) => unknownType(name)),
      }),
    );
    expect(reasons).toEqual([NESTED("node_modules/pkg/y")]);
  });

  it("names every nested repository it finds, however deep", async () => {
    const worktree = await fixture({ ignore: ".proof/\n" });
    await repository(
      path.join(worktree.path, "node_modules/.cache/stack/repos/orbital"),
    );
    await repository(path.join(worktree.path, ".proof/fe"));
    await settle();
    const reasons = await removal(worktree);
    expect(reasons).toContain(
      NESTED(".proof/fe, node_modules/.cache/stack/repos/orbital"),
    );
  });

  it("removes a worktree whose package links to a repository outside it, and leaves that repository whole", async () => {
    const worktree = await fixture();
    const outsideRepository = path.join(worktree.outside, "z");
    const commit = await repository(outsideRepository);
    await fs.mkdir(path.join(worktree.path, "node_modules"));
    await fs.symlink(
      outsideRepository,
      path.join(worktree.path, "node_modules", "z"),
    );
    await settle();
    await expect(removal(worktree)).resolves.toBe("removed");
    expect(
      await objectExists(path.join(outsideRepository, ".git"), commit),
    ).toBe(true);
  });

  it("keeps a module repository created after the final inspection", async () => {
    const worktree = await fixture();
    const reasons = await removal(worktree, {
      afterFinalInspection: async (_worktreePath, gitDir) => {
        await fs.mkdir(path.join(gitDir, "modules", "late"), {
          recursive: true,
        });
        await fs.writeFile(path.join(gitDir, "modules", "late", "HEAD"), "x\n");
      },
    });
    expect(reasons).toContain(
      "new or changed Git metadata was found after its final inspection",
    );
  });

  it("keeps a nested repository created in the worktree after the final inspection", async () => {
    const worktree = await fixture();
    const reasons = await removal(worktree, {
      afterFinalInspection: async (worktreePath) => {
        await repository(path.join(worktreePath, "node_modules", "late"));
      },
    });
    expect(reasons).not.toBe("removed");
    expect(reasons).toContain(
      "new or changed data was found during directory removal",
    );
    expect(
      existsSync(
        path.join(worktree.path, "node_modules", "late", ".git", "HEAD"),
      ),
    ).toBe(true);
  });

  it.skipIf(asRoot)(
    "keeps the worktree when a directory under node_modules cannot be read",
    async () => {
      const worktree = await fixture();
      const locked = path.join(worktree.path, "node_modules", "locked");
      await fs.mkdir(locked, { recursive: true });
      await fs.chmod(locked, 0o000);
      await settle();
      const reasons = await removal(worktree);
      expect(reasons).not.toBe("removed");
      expect(
        (reasons as string[]).filter((reason) =>
          reason.startsWith(`${UNFINISHED}EACCES`),
        ),
      ).toHaveLength(1);
    },
  );

  it.skipIf(asRoot)(
    "keeps the worktree when a directory's permissions change between its lstat and its open",
    async () => {
      const worktree = await fixture();
      const target = path.join(worktree.path, "node_modules", "pkg");
      await fs.mkdir(target, { recursive: true });
      await settle();
      const reasons = await removal(
        worktree,
        scan({
          beforeDirectoryOpen: async (directory) => {
            if (path.basename(directory) === "pkg")
              await fs.chmod(directory, 0o000);
          },
        }),
      );
      expect(reasons).not.toBe("removed");
      expect(
        (reasons as string[]).filter((reason) =>
          reason.startsWith(`${UNFINISHED}EACCES`),
        ),
      ).toHaveLength(1);
    },
  );

  async function manyEntries(count: number): Promise<Fixture> {
    const worktree = await fixture();
    const many = path.join(worktree.path, "node_modules", "many");
    await fs.mkdir(many, { recursive: true });
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        fs.writeFile(path.join(many, `f${i}`), ""),
      ),
    );
    await settle();
    return worktree;
  }

  function stoppedBy(reasons: string[] | "removed", detail: string): number {
    expect(reasons).not.toBe("removed");
    return (reasons as string[]).filter((reason) =>
      reason.startsWith(`${UNFINISHED}${detail})`),
    ).length;
  }

  it("keeps the worktree when the repository check has no time at all", async () => {
    const worktree = await manyEntries(1);
    const reasons = await removal(worktree, scan({ budgetMs: 0 }));
    expect(stoppedBy(reasons, "it took longer than 0 ms")).toBe(1);
  });

  it("stops reading a slow directory listing at its deadline, entry by entry", async () => {
    const worktree = await manyEntries(200);
    let reads = 0;
    const reasons = await removal(
      worktree,
      scan({
        budgetMs: 100,
        openDirectoryEntries: async (directory, entry) => {
          const inner = await listed(directory);
          return (async function* () {
            for await (const child of inner) {
              if (path.basename(entry) === "many") {
                reads += 1;
                await delay(5);
              }
              yield child;
            }
          })();
        },
      }),
    );
    expect(stoppedBy(reasons, "it took longer than 100 ms")).toBe(1);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(100);
  });

  it("stops reading a directory with a million entries at its deadline, without reading them all", async () => {
    const worktree = await manyEntries(1);
    let yielded = 0;
    const reasons = await removal(
      worktree,
      scan({
        budgetMs: 200,
        openDirectoryEntries: async (directory, entry) =>
          path.basename(entry) === "many"
            ? (async function* () {
                for (let i = 0; i < 1_000_000; i += 1) {
                  yielded += 1;
                  yield unknownType(`n${i}`);
                }
              })()
            : listed(directory),
      }),
    );
    expect(stoppedBy(reasons, "it took longer than 200 ms")).toBe(1);
    expect(yielded).toBeLessThan(1_000_000);
  });

  it("stops reading at its entry limit, without reading the rest", async () => {
    const worktree = await manyEntries(1);
    let yielded = 0;
    const reasons = await removal(
      worktree,
      scan({
        entryLimit: 1_000,
        openDirectoryEntries: async (directory, entry) =>
          path.basename(entry) === "many"
            ? (async function* () {
                for (let i = 0; i < 1_000_000; i += 1) {
                  yielded += 1;
                  yield unknownType(`n${i}`);
                }
              })()
            : listed(directory),
      }),
    );
    expect(stoppedBy(reasons, "it has more than 1000 entries")).toBe(1);
    expect(yielded).toBeLessThanOrEqual(1_001);
  });

  it.each([
    ["a million entries", 0],
    ["slow entries", 20],
  ] as const)(
    "reads at most six entries of a modules directory with %s",
    async (_label, pause) => {
      const worktree = await fixture();
      const modules = path.join(worktree.gitDir, "modules");
      await fs.mkdir(modules);
      await settle();
      let yielded = 0;
      const started = performance.now();
      const reasons = await removal(
        worktree,
        scan({
          openDirectoryEntries: async (directory, entry) =>
            entry === modules
              ? (async function* () {
                  for (let i = 0; i < 1_000_000; i += 1) {
                    yielded += 1;
                    if (pause > 0) await delay(pause);
                    yield unknownType(`n${i}`);
                  }
                })()
              : listed(directory),
        }),
      );
      expect(reasons).toEqual([
        MODULES(
          "modules/n0, modules/n1, modules/n2, modules/n3, modules/n4 and more",
        ),
      ]);
      expect(yielded).toBeLessThanOrEqual(12);
      expect(performance.now() - started).toBeLessThan(5_000);
    },
  );

  const stalled = (): AsyncIterable<DirectoryEntry> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<DirectoryEntry>>(() => undefined),
    }),
  });

  it("gives the 300 ms budget reason, in under 10 s, when a modules listing stalls", async () => {
    const worktree = await fixture();
    const modules = path.join(worktree.gitDir, "modules");
    await fs.mkdir(modules);
    await settle();
    const started = performance.now();
    const reasons = await removal(
      worktree,
      scan({
        budgetMs: 300,
        openDirectoryEntries: async (directory, entry) =>
          entry === modules ? stalled() : listed(directory),
      }),
    );
    expect(reasons).toEqual([
      "could not check for submodule repositories (it took longer than 300 ms)",
      `${UNFINISHED}it took longer than 300 ms)`,
    ]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("gives the 300 ms budget reason, in under 10 s, when a directory listing stalls", async () => {
    const worktree = await fixture();
    await fs.mkdir(path.join(worktree.path, "node_modules", "stall"), {
      recursive: true,
    });
    await settle();
    const started = performance.now();
    const reasons = await removal(
      worktree,
      scan({
        budgetMs: 300,
        openDirectoryEntries: async (directory, entry) =>
          path.basename(entry) === "stall" ? stalled() : listed(directory),
      }),
    );
    expect(reasons).toEqual([`${UNFINISHED}it took longer than 300 ms)`]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("leaves the walk no time once a stalled modules listing has used the whole budget, every time", async () => {
    const worktree = await fixture();
    const modules = path.join(worktree.gitDir, "modules");
    await fs.mkdir(modules);
    await settle();
    const walked: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reasons = await removal(
        worktree,
        scan({
          budgetMs: 50,
          openDirectoryEntries: async (directory, entry) => {
            if (entry === modules) return stalled();
            walked.push(entry);
            return listed(directory);
          },
        }),
      );
      expect(reasons).toEqual([
        "could not check for submodule repositories (it took longer than 50 ms)",
        `${UNFINISHED}it took longer than 50 ms)`,
      ]);
    }
    expect(walked).toEqual([]);
  });

  function descriptorsOn(target: { dev: number; ino: number }): number {
    const table = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    let count = 0;
    for (const name of readdirSync(table)) {
      const info = (() => {
        try {
          return fstatSync(Number(name));
        } catch {
          return null;
        }
      })();
      if (info?.dev === target.dev && info.ino === target.ino) count += 1;
    }
    return count;
  }

  it.each([
    [
      "a modules listing",
      (worktree: Fixture) => path.join(worktree.gitDir, "modules"),
      [
        "could not check for submodule repositories (it took longer than 300 ms)",
        `${UNFINISHED}it took longer than 300 ms)`,
      ],
    ],
    [
      "a directory listing",
      (worktree: Fixture) => path.join(worktree.path, "node_modules", "stall"),
      [`${UNFINISHED}it took longer than 300 ms)`],
    ],
  ] as const)(
    "closes the anchor before listing, and the stalled Dir at the deadline, for %s",
    async (_label, stalledAt, expected) => {
      const worktree = await fixture();
      const target = stalledAt(worktree);
      await fs.mkdir(target, { recursive: true });
      await settle();
      const identity = await fs.stat(target);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closes = 0;
      let duringStall = -1;
      const reasons = await removal(
        worktree,
        scan({
          budgetMs: 300,
          openDirectoryEntries: async (directory, entry) => {
            if (path.resolve(entry) !== path.resolve(target))
              return listed(directory);
            const dir = await fs.opendir(directory);
            const listing: DirectoryListing = {
              [Symbol.asyncIterator]: () => ({
                next: async (): Promise<IteratorResult<DirectoryEntry>> => {
                  duringStall = descriptorsOn(identity);
                  await released;
                  const child = await dir.read();
                  return child === null
                    ? { done: true, value: undefined }
                    : { done: false, value: child };
                },
              }),
              close: async () => {
                closes += 1;
                await dir.close();
              },
            };
            return listing;
          },
        }),
      );
      const atReturn = descriptorsOn(identity);
      release();
      await delay(50);
      expect(reasons).toEqual(expected);
      expect(duringStall).toBe(1);
      expect(closes).toBe(1);
      expect(atReturn).toBe(0);
    },
  );

  it.each([
    [
      "a modules listing",
      "resolves",
      (worktree: Fixture) => path.join(worktree.gitDir, "modules"),
      [
        "could not check for submodule repositories (it took longer than 300 ms)",
        `${UNFINISHED}it took longer than 300 ms)`,
      ],
    ],
    [
      "a directory listing",
      "resolves",
      (worktree: Fixture) => path.join(worktree.path, "node_modules", "stall"),
      [`${UNFINISHED}it took longer than 300 ms)`],
    ],
    [
      "a modules listing",
      "rejects",
      (worktree: Fixture) => path.join(worktree.gitDir, "modules"),
      [
        "could not check for submodule repositories (it took longer than 300 ms)",
        `${UNFINISHED}it took longer than 300 ms)`,
      ],
    ],
    [
      "a directory listing",
      "rejects",
      (worktree: Fixture) => path.join(worktree.path, "node_modules", "stall"),
      [`${UNFINISHED}it took longer than 300 ms)`],
    ],
  ] as const)(
    "keeps the anchor of %s whose open is still in flight at the deadline until that open %s, then closes everything once",
    async (_label, outcome, stalledAt, expected) => {
      const worktree = await fixture();
      const target = stalledAt(worktree);
      await fs.mkdir(target, { recursive: true });
      await settle();
      const identity = await fs.stat(target);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closes = 0;
      let reads = 0;
      let closesBeforeNextTask = -1;
      try {
        const started = performance.now();
        const reasons = await removal(
          worktree,
          scan({
            budgetMs: 300,
            openDirectoryEntries: async (directory, entry) => {
              if (path.resolve(entry) !== path.resolve(target))
                return listed(directory);
              await released;
              if (outcome === "rejects")
                throw Object.assign(new Error("EIO: i/o error, opendir"), {
                  code: "EIO",
                });
              const dir = await fs.opendir(directory);
              setImmediate(() => {
                closesBeforeNextTask = closes;
              });
              const listing: DirectoryListing = {
                [Symbol.asyncIterator]: () => ({
                  next: async (): Promise<IteratorResult<DirectoryEntry>> => {
                    reads += 1;
                    const child = await dir.read();
                    return child === null
                      ? { done: true, value: undefined }
                      : { done: false, value: child };
                  },
                }),
                close: async () => {
                  closes += 1;
                  await dir.close();
                },
              };
              return listing;
            },
          }),
        );
        const elapsed = performance.now() - started;
        const atReturn = descriptorsOn(identity);
        await delay(50);
        const whileInFlight = descriptorsOn(identity);
        release();
        await delay(50);
        expect(reasons).toEqual(expected);
        expect(elapsed).toBeLessThan(10_000);
        expect(atReturn).toBe(1);
        expect(whileInFlight).toBe(1);
        expect(descriptorsOn(identity)).toBe(0);
        expect(reads).toBe(0);
        expect(closes).toBe(outcome === "resolves" ? 1 : 0);
        if (outcome === "resolves") expect(closesBeforeNextTask).toBe(1);
        expect(unhandled).toEqual([]);
      } finally {
        release();
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it("never lists a directory that modules is swapped for between its lstat and its open", async () => {
    const worktree = await fixture();
    const modules = path.join(worktree.gitDir, "modules");
    await fs.mkdir(modules);
    const elsewhere = path.join(worktree.outside, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "outside-name"), "");
    await settle();
    let swapped = false;
    const reasons = await removal(
      worktree,
      scan({
        beforeDirectoryOpen: async (directory) => {
          if (directory !== modules || swapped) return;
          swapped = true;
          await fs.rm(modules, { recursive: true });
          await fs.symlink(elsewhere, modules);
        },
      }),
    );
    expect(swapped).toBe(true);
    expect(reasons).not.toBe("removed");
    expect(
      (reasons as string[]).some((reason) => reason.includes("outside-name")),
    ).toBe(false);
    expect(
      (reasons as string[]).filter((reason) =>
        reason.startsWith("could not check for submodule repositories ("),
      ),
    ).toHaveLength(1);
  });

  it.skipIf(asRoot)(
    "keeps the worktree when a listed directory's entries cannot be checked",
    async () => {
      const worktree = await fixture();
      const shaped = path.join(worktree.path, "node_modules", "shaped");
      await fs.mkdir(path.join(shaped, "refs"), { recursive: true });
      await fs.mkdir(path.join(shaped, "objects"));
      await fs.writeFile(path.join(shaped, "HEAD"), "ref: refs/heads/main\n");
      await fs.chmod(shaped, 0o444);
      await settle();
      const reasons = await removal(worktree);
      await fs.chmod(shaped, 0o755);
      expect(reasons).not.toBe("removed");
      expect(
        (reasons as string[]).filter((reason) =>
          reason.startsWith(`${UNFINISHED}EACCES`),
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps the worktree when a directory listing fails part way through", async () => {
    const worktree = await fixture();
    await fs.mkdir(path.join(worktree.path, "node_modules", "failing"), {
      recursive: true,
    });
    await settle();
    const reasons = await removal(
      worktree,
      scan({
        openDirectoryEntries: async (directory, entry) =>
          path.basename(entry) === "failing"
            ? (async function* () {
                yield unknownType("first");
                throw Object.assign(new Error("EIO: i/o error, read"), {
                  code: "EIO",
                });
              })()
            : listed(directory),
      }),
    );
    expect(reasons).toEqual([`${UNFINISHED}EIO: i/o error, read)`]);
  });

  it("keeps the worktree when a directory chain is deeper than a path can be", async () => {
    const worktree = await fixture();
    const deep = path.join(worktree.path, "node_modules", "deep");
    await fs.mkdir(deep, { recursive: true });
    await execFile("sh", [
      "-c",
      'cd "$1" && mkdir c && i=0 && while [ $i -lt 420 ]; do mkdir t && mv c t/d0123456789 && mv t c || exit 1; i=$((i+1)); done',
      "sh",
      deep,
    ]);
    await settle();
    const reasons = await removal(worktree);
    expect(reasons).not.toBe("removed");
    expect(
      (reasons as string[]).filter((reason) =>
        reason.startsWith(`${UNFINISHED}ENAMETOOLONG`),
      ),
    ).toHaveLength(1);
  });

  it("keeps the worktree for a FIFO or a socket named .git without opening it", async () => {
    const worktree = await fixture();
    const fifo = path.join(worktree.path, "node_modules", "f");
    const socket = path.join(worktree.path, "node_modules", "s");
    await fs.mkdir(fifo, { recursive: true });
    await fs.mkdir(socket, { recursive: true });
    await execFile("mkfifo", [path.join(fifo, ".git")]);
    const listened = spawnSync(
      process.execPath,
      [
        "-e",
        "require('net').createServer().listen('.git', () => process.exit(0))",
      ],
      { cwd: socket, timeout: 10_000 },
    );
    expect(listened.status).toBe(0);
    expect((await fs.lstat(path.join(socket, ".git"))).isSocket()).toBe(true);
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      NESTED("node_modules/f, node_modules/s"),
    ]);
  });

  it("keeps the worktree for a FIFO named HEAD alone without opening it", async () => {
    const worktree = await fixture();
    const directory = path.join(worktree.path, "node_modules", "h");
    await fs.mkdir(directory, { recursive: true });
    await execFile("mkfifo", [path.join(directory, "HEAD")]);
    await settle();
    await expect(removal(worktree)).resolves.toEqual([
      NESTED("node_modules/h"),
    ]);
  });

  it("walks a pnpm store, and still removes a clean one", async () => {
    const worktree = await fixture();
    const store = path.join(
      worktree.path,
      "node_modules",
      ".pnpm",
      "pkg@1.0.0",
      "node_modules",
      "pkg",
    );
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, "index.js"), "");
    await fs.symlink(
      ".pnpm/pkg@1.0.0/node_modules/pkg",
      path.join(worktree.path, "node_modules", "pkg"),
    );
    await settle();
    await expect(removal(worktree)).resolves.toBe("removed");
    const kept = await fixture();
    await repository(
      path.join(
        kept.path,
        "node_modules",
        ".pnpm",
        "pkg@1.0.0",
        "node_modules",
        "pkg",
      ),
    );
    await settle();
    await expect(removal(kept)).resolves.toEqual([
      NESTED("node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"),
    ]);
  });

  it.each([
    ["node_modules/cache/snapshot.git", "node_modules/cache/snapshot.git"],
    ["node_modules/vendor/store", "node_modules/vendor/store"],
  ])(
    "keeps a bare repository at %s whatever its name",
    async (relative, named) => {
      const worktree = await fixture();
      const bare = path.join(worktree.path, relative);
      await fs.mkdir(path.dirname(bare), { recursive: true });
      await git(path.dirname(bare), "init", "--bare", bare);
      const written = spawnSync(
        "git",
        ["--git-dir", bare, "hash-object", "-w", "--stdin"],
        {
          input: "only here\n",
        },
      );
      const sha = written.stdout.toString().trim();
      await settle();
      await expect(removal(worktree)).resolves.toEqual([NESTED(named)]);
      expect(await objectExists(bare, sha)).toBe(true);
    },
  );

  it.each([
    ["a plain HEAD", ["HEAD"], []],
    ["HEAD and refs but no objects or commondir", ["HEAD"], ["refs"]],
    ["HEAD and objects but no refs", ["HEAD"], ["objects"]],
  ])("removes a directory holding %s", async (_label, files, directories) => {
    const worktree = await fixture();
    const directory = path.join(worktree.path, "node_modules", "lookalike");
    await fs.mkdir(directory, { recursive: true });
    for (const file of files)
      await fs.writeFile(path.join(directory, file), "x\n");
    for (const name of directories) await fs.mkdir(path.join(directory, name));
    await settle();
    await expect(removal(worktree)).resolves.toBe("removed");
  });

  it("keeps the worktree when a directory is swapped for another directory between its lstat and its open", async () => {
    const worktree = await fixture();
    const replacement = path.join(worktree.outside, "replacement");
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(replacement, "r"), "");
    const swapped = path.join(worktree.path, "node_modules", "swap");
    await fs.mkdir(swapped, { recursive: true });
    await settle();
    const reasons = await removal(
      worktree,
      scan({
        beforeDirectoryOpen: async (directory) => {
          if (path.basename(directory) !== "swap") return;
          await fs.rename(directory, path.join(worktree.outside, "original"));
          await fs.rename(replacement, directory);
        },
      }),
    );
    expect(reasons).not.toBe("removed");
    expect(
      (reasons as string[]).filter(
        (reason) =>
          reason.startsWith(UNFINISHED) &&
          reason.includes("was replaced while it was checked"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the worktree when a directory is swapped for a symbolic link between its lstat and its open", async () => {
    const worktree = await fixture();
    const outsideRepository = path.join(worktree.outside, "target");
    const commit = await repository(outsideRepository);
    const swapped = path.join(worktree.path, "node_modules", "swap");
    await fs.mkdir(swapped, { recursive: true });
    await settle();
    const reasons = await removal(
      worktree,
      scan({
        beforeDirectoryOpen: async (directory) => {
          if (path.basename(directory) !== "swap") return;
          await fs.rm(directory, { recursive: true });
          await fs.symlink(outsideRepository, directory);
        },
      }),
    );
    expect(reasons).not.toBe("removed");
    expect(
      (reasons as string[]).filter((reason) => reason.startsWith(UNFINISHED)),
    ).toHaveLength(1);
    expect(
      await objectExists(path.join(outsideRepository, ".git"), commit),
    ).toBe(true);
  });
});
