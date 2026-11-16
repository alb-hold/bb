import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import type { RepositoryScanHooks } from "./repository-detection.js";
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

  it.each([
    ["no time at all", { budgetMs: 0 }],
    [
      "a slow directory listing",
      {
        budgetMs: 1,
        readDirectoryNames: async (directory: string) => {
          await delay(20);
          return fs.readdir(directory);
        },
      },
    ],
    [
      "a directory with a million entries",
      {
        budgetMs: 200,
        readDirectoryNames: async (directory: string) => {
          const names = await fs.readdir(directory);
          return names.includes("many-marker")
            ? [
                ...names,
                ...Array.from({ length: 1_000_000 }, (_, i) => `n${i}`),
              ]
            : names;
        },
      },
    ],
  ] as const)(
    "keeps the worktree when the repository check runs out of time on %s",
    async (_label, hooks) => {
      const worktree = await fixture();
      await fs.mkdir(path.join(worktree.path, "node_modules", "many"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(worktree.path, "node_modules", "many", "many-marker"),
        "",
      );
      await settle();
      const reasons = await removal(worktree, scan(hooks));
      expect(reasons).not.toBe("removed");
      expect(
        (reasons as string[]).filter((reason) =>
          reason.startsWith(
            `${UNFINISHED}it took longer than ${hooks.budgetMs} ms)`,
          ),
        ),
      ).toHaveLength(1);
    },
  );

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
