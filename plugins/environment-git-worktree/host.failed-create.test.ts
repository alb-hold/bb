import { execFile } from "node:child_process";
import { existsSync, statSync, utimesSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeHostEntry } from "./host.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const PATH_KEY = "thr_failed";
const FAILING_COMPLETION_LINK =
  "ln -s /nonexistent-bb-test/completed ../repo.completed";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function createFixture(options: {
  trackedFiles?: ReadonlyArray<{ name: string; content: string }>;
  hookLines: readonly string[];
  includedFiles: ReadonlyArray<{ name: string; content: string }>;
}) {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-failed-create-"));
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await writeFile(join(sourcePath, ".gitignore"), "inc/\n");
  await writeFile(join(sourcePath, ".worktreeinclude"), "inc/\n");
  for (const file of options.trackedFiles ?? []) {
    await writeFile(join(sourcePath, file.name), file.content);
  }
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  await mkdir(join(sourcePath, "inc"));
  for (const file of options.includedFiles) {
    await writeFile(join(sourcePath, "inc", file.name), file.content);
  }
  await writeFile(
    join(sourcePath, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\n${[FAILING_COMPLETION_LINK, ...options.hookLines].join("\n")}\n`,
    { mode: 0o755 },
  );
  const harness = experimental_createHostEntryHarness(
    createWorktreeHostEntry(),
    { experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") } },
  );
  const targetPath = join(dataDir, "worktrees", PATH_KEY, "repo");
  const create = () =>
    harness.experimental_call("create", {
      operationId: "create",
      sourcePath,
      pathKey: PATH_KEY,
      branchName: "bb/failed-create",
      baseBranch: { kind: "default" as const },
      branchMode: "reset" as const,
    });
  return { dataDir, harness, sourcePath, targetPath, create };
}

describe("a failed create keeps recoverable work in the worktree it just made", () => {
  it("keeps an untracked file that someone else put there", async () => {
    const fixture = await createFixture({
      hookLines: ['echo "work in progress" > extra.txt'],
      includedFiles: [],
    });
    const result = await fixture.create();
    const extra = join(fixture.targetPath, "extra.txt");
    expect(existsSync(extra), JSON.stringify(result)).toBe(true);
    expect(await readFile(extra, "utf8")).toBe("work in progress\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("keeps an edit to a tracked file", async () => {
    const fixture = await createFixture({
      hookLines: ['echo "edited by someone" >> README.md'],
      includedFiles: [],
    });
    const result = await fixture.create();
    const readme = join(fixture.targetPath, "README.md");
    expect(existsSync(readme), JSON.stringify(result)).toBe(true);
    expect(await readFile(readme, "utf8")).toBe("hello\nedited by someone\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("moves untouched copies to a private folder outside the worktrees and removes the worktree", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [
        { name: "a.env", content: "A=1\n" },
        { name: "b.env", content: "B=2\n" },
      ],
    });
    const result = await fixture.create();
    expect(result.status).toBe("failed");
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(existsSync(join(fixture.dataDir, "worktrees", PATH_KEY))).toBe(
      false,
    );
    const directory = retainedDirectory(result);
    expect(directory.startsWith(join(fixture.dataDir, "retained") + "/")).toBe(
      true,
    );
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(await readFile(join(directory, "inc", "a.env"), "utf8")).toBe(
      "A=1\n",
    );
    expect(await readFile(join(directory, "inc", "b.env"), "utf8")).toBe(
      "B=2\n",
    );
    expect(JSON.stringify(result)).toContain("ENOENT");
    expect(JSON.stringify(result)).toContain("never deletes it");
    await fixture.harness.experimental_dispose();
  });

  it("lets a retry run after a failed create kept its copies, leaving the first folder alone", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const first = await fixture.create();
    const firstDirectory = retainedDirectory(first);
    const second = await fixture.create();
    const secondDirectory = retainedDirectory(second);

    expect(second.status).toBe("failed");
    expect(secondDirectory).not.toBe(firstDirectory);
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(await readFile(join(firstDirectory, "inc", "a.env"), "utf8")).toBe(
      "A=1\n",
    );
    expect(await readFile(join(secondDirectory, "inc", "a.env"), "utf8")).toBe(
      "A=1\n",
    );
    await fixture.harness.experimental_dispose();
  });

  it("keeps a foreign file in a directory bb also copied into", async () => {
    const fixture = await createFixture({
      hookLines: [
        "mkdir -p inc",
        'echo "not from the source" > inc/foreign.env',
      ],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const result = await fixture.create();
    const foreign = join(fixture.targetPath, "inc", "foreign.env");
    expect(existsSync(foreign), JSON.stringify(result)).toBe(true);
    expect(await readFile(foreign, "utf8")).toBe("not from the source\n");
    expect(result.status).toBe("failed");
    await fixture.harness.experimental_dispose();
  });

  it("stops nothing and keeps everything when the worktree carries a committed .keep-worktree", async () => {
    const fixture = await createFixture({
      trackedFiles: [{ name: ".keep-worktree", content: "" }],
      hookLines: [
        "(sleep 300 > /dev/null 2>&1 & echo $! > ../hook-sleeper.pid)",
      ],
      includedFiles: [],
    });
    const result = await fixture.create();
    const pid = Number(
      (
        await readFile(
          join(fixture.targetPath, "..", "hook-sleeper.pid"),
          "utf8",
        )
      ).trim(),
    );
    try {
      expect(existsSync(join(fixture.targetPath, ".keep-worktree"))).toBe(true);
      expect(isAlive(pid)).toBe(true);
      expect(result.status).toBe("failed");
    } finally {
      process.kill(pid, "SIGKILL");
      await fixture.harness.experimental_dispose();
    }
  });

  it("pins how Git lists the files of an ignored directory, which the ownership check relies on", async () => {
    const fixture = await createFixture({ hookLines: [], includedFiles: [] });
    const repo = fixture.sourcePath;
    await mkdir(join(repo, "inc", "deep"), { recursive: true });
    await writeFile(join(repo, "inc", "a.env"), "A\n");
    await writeFile(join(repo, "inc", "deep", "b.env"), "B\n");
    const status = await git(
      repo,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
    );
    expect(status.split("\0").filter(Boolean).sort()).toEqual([
      "!! inc/a.env",
      "!! inc/deep/b.env",
    ]);
    await fixture.harness.experimental_dispose();
  });

  describe.each([
    { label: "changed after it was copied", sameSizeAndMtime: false },
    {
      label: "edited to the same size with its modification time restored",
      sameSizeAndMtime: true,
    },
  ])("a copied file $label", ({ sameSizeAndMtime }) => {
    it("is kept", async () => {
      const copyCount = 1500;
      const fixture = await createFixture({
        hookLines: [],
        includedFiles: Array.from({ length: copyCount }, (_, index) => ({
          name: `f${String(index).padStart(5, "0")}.env`,
          content: `VALUE=${String(index).padStart(5, "0")}\n`,
        })),
      });
      const pending = fixture.create();
      const first = join(fixture.targetPath, "inc", "f00000.env");
      const last = join(
        fixture.targetPath,
        "inc",
        `f${String(copyCount - 1).padStart(5, "0")}.env`,
      );
      await expect
        .poll(() => existsSync(first), { interval: 2, timeout: 20_000 })
        .toBe(true);
      expect(
        existsSync(last),
        "fixture too fast: the copy finished before the edit could land",
      ).toBe(false);
      const copiedStat = statSync(first);
      const edited = sameSizeAndMtime ? "VALUE=X0000\n" : "VALUE=changed\n";
      await writeFile(first, edited);
      if (sameSizeAndMtime) {
        utimesSync(first, copiedStat.atime, copiedStat.mtime);
      }
      const result = await pending;
      expect(existsSync(first), JSON.stringify(result)).toBe(true);
      expect(await readFile(first, "utf8")).toBe(edited);
      expect(result.status).toBe("failed");
      await fixture.harness.experimental_dispose();
    }, 60_000);
  });
});

type Seam = "edit" | "replace-file" | "replace-symlink" | "late-fd-write";

function retainedDirectory(result: object): string {
  const message =
    "message" in result && typeof result.message === "string"
      ? result.message
      : "";
  const found = /at (\S+failed-create-\S+) \(each under/u.exec(message);
  if (found === null) throw new Error(`no retained path in ${message}`);
  return found[1]!;
}

function installSeam(seam: Seam, copy: string, outside: string) {
  const original = fsp.realpath.bind(fsp);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let fired = false;
  vi.spyOn(fsp, "realpath").mockImplementation(((
    ...args: Parameters<typeof fsp.realpath>
  ) => {
    const stack = new Error().stack ?? "";
    if (
      seam === "late-fd-write" &&
      handle === null &&
      stack.includes("inspectCreatedBy")
    ) {
      return (async () => {
        handle = await open(copy, "r+");
        return original(...args);
      })();
    }
    if (!fired && stack.includes("retainCreatedCopies")) {
      fired = true;
      return (async () => {
        if (seam === "edit") {
          await writeFile(copy, "USER EDIT AFTER VERIFY\n");
        } else if (seam === "replace-file") {
          await rm(copy);
          await writeFile(copy, "USER FILE THAT ARRIVED LATER\n");
        } else if (seam === "replace-symlink") {
          await rm(copy);
          await symlink(outside, copy);
        } else if (handle !== null) {
          await handle.write("LATE BYTES\n", 0);
        }
        return original(...args);
      })();
    }
    return original(...args);
  }) as typeof fsp.realpath);
  return {
    fired: () => fired,
    close: async () => {
      await handle?.close();
    },
  };
}

describe("a failed create never destroys a copy that changed after it was checked", () => {
  it.each([
    ["edit", "USER EDIT AFTER VERIFY\n"],
    ["replace-file", "USER FILE THAT ARRIVED LATER\n"],
  ] as const)(
    "keeps the bytes of a %s that lands after the check",
    async (seam, expected) => {
      const fixture = await createFixture({
        hookLines: [],
        includedFiles: [{ name: "a.env", content: "A=1\n" }],
      });
      const copy = join(fixture.targetPath, "inc", "a.env");
      const hook = installSeam(
        seam,
        copy,
        join(fixture.dataDir, "outside.txt"),
      );
      const result = await fixture.create();
      await hook.close();
      expect(hook.fired()).toBe(true);
      expect(result.status).toBe("failed");
      const directory = retainedDirectory(result);
      expect(await readFile(join(directory, "inc", "a.env"), "utf8")).toBe(
        expected,
      );
      await fixture.harness.experimental_dispose();
    },
  );

  it("keeps bytes written through a descriptor opened before the check", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const copy = join(fixture.targetPath, "inc", "a.env");
    const hook = installSeam("late-fd-write", copy, "");
    const result = await fixture.create();
    await hook.close();
    expect(hook.fired()).toBe(true);
    const directory = retainedDirectory(result);
    expect(
      (await readFile(join(directory, "inc", "a.env"), "utf8")).startsWith(
        "LATE BYTES\n",
      ),
    ).toBe(true);
    await fixture.harness.experimental_dispose();
  });

  it("keeps the worktree and the outside file when the copy became a symlink", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const copy = join(fixture.targetPath, "inc", "a.env");
    const outside = join(fixture.dataDir, "outside.txt");
    await writeFile(outside, "OUTSIDE\n");
    const hook = installSeam("replace-symlink", copy, outside);
    const result = await fixture.create();
    expect(hook.fired()).toBe(true);
    expect(result.status).toBe("failed");
    expect(existsSync(fixture.targetPath)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE\n");
    expect(JSON.stringify(result)).toContain("no longer a plain file");
    await fixture.harness.experimental_dispose();
  });
});

describe("what a failed create leaves behind when keeping the copies goes wrong", () => {
  it("keeps a sentinel in the retained folder and a file that reappears at the original path", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    const sentinelDirectory = join(fixture.dataDir, "retained", "sentinel");
    await mkdir(sentinelDirectory, { recursive: true });
    await writeFile(join(sentinelDirectory, "keep.txt"), "SENTINEL\n");
    const copy = join(fixture.targetPath, "inc", "a.env");
    const originalRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation((async (
      ...args: Parameters<typeof fsp.rename>
    ) => {
      await originalRename(...args);
      await writeFile(copy, "ARRIVED AFTER THE MOVE\n");
    }) as typeof fsp.rename);
    const result = await fixture.create();
    expect(result.status).toBe("failed");
    expect(await readFile(copy, "utf8")).toBe("ARRIVED AFTER THE MOVE\n");
    expect(await readFile(join(sentinelDirectory, "keep.txt"), "utf8")).toBe(
      "SENTINEL\n",
    );
    const directory = retainedDirectory(result);
    expect(await readFile(join(directory, "inc", "a.env"), "utf8")).toBe(
      "A=1\n",
    );
    expect(JSON.stringify(result)).toContain("changed after bb made it");
    await fixture.harness.experimental_dispose();
  });

  it("leaves the copy and the worktree alone when the move crosses filesystems", async () => {
    const fixture = await createFixture({
      hookLines: [],
      includedFiles: [{ name: "a.env", content: "A=1\n" }],
    });
    vi.spyOn(fsp, "rename").mockImplementation((async () => {
      throw Object.assign(new Error("cross-device link not permitted"), {
        code: "EXDEV",
      });
    }) as typeof fsp.rename);
    const result = await fixture.create();
    expect(result.status).toBe("failed");
    expect(
      await readFile(join(fixture.targetPath, "inc", "a.env"), "utf8"),
    ).toBe("A=1\n");
    expect(JSON.stringify(result)).toContain("different filesystem");
    const retainedRoot = join(fixture.dataDir, "retained");
    for (const entry of await readdir(retainedRoot)) {
      expect(await readdir(join(retainedRoot, entry, "inc"))).toEqual([]);
    }
    await fixture.harness.experimental_dispose();
  });
});
