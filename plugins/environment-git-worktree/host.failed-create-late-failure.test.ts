import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeHostEntry } from "./host.js";

const gitFailure = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("bb-environment-provider-host/git", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("bb-environment-provider-host/git")>();
  return {
    ...original,
    runGit: ((
      ...callArgs: Parameters<typeof original.runGit>
    ): ReturnType<typeof original.runGit> => {
      const [args] = callArgs;
      if (
        gitFailure.error !== null &&
        args.includes("worktree") &&
        args.includes("remove")
      ) {
        return Promise.reject(gitFailure.error);
      }
      return original.runGit(...callArgs);
    }) as typeof original.runGit,
  };
});

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const PATH_KEY = "thr_failed";
const FAILING_COMPLETION_LINK =
  "ln -s /nonexistent-bb-test/completed ../repo.completed";

afterEach(async () => {
  gitFailure.error = null;
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

function retainedDirectory(result: object): string {
  const message =
    "message" in result && typeof result.message === "string"
      ? result.message
      : "";
  const found = /at (\S+failed-create-\S+) \(each under/u.exec(message);
  if (found === null) throw new Error(`no retained path in ${message}`);
  return found[1]!;
}

describe("a failed create that fails again after it moved the copies", () => {
  it.each([
    ["git cannot be started", new Error("spawn git ENOENT (simulated)")],
    [
      "git is aborted",
      Object.assign(new Error("git was aborted (simulated)"), {
        name: "AbortError",
      }),
    ],
  ] as const)(
    "still names where the copies are when %s",
    async (_label, failure) => {
      const fixture = await createFixture({
        hookLines: [],
        includedFiles: [{ name: "a.env", content: "A=1\n" }],
      });
      gitFailure.error = failure;
      const result = await fixture.create();

      expect(result.status).toBe("failed");
      const message = "message" in result ? result.message : "";
      expect(message).toContain(failure.message);
      expect(message).toContain("Create failed earlier");
      expect(message).toContain("never deletes it");
      const directory = retainedDirectory(result);
      expect(
        directory.startsWith(join(fixture.dataDir, "retained") + "/"),
      ).toBe(true);
      expect(await readFile(join(directory, "inc", "a.env"), "utf8")).toBe(
        "A=1\n",
      );
      expect(existsSync(fixture.targetPath)).toBe(true);
      await fixture.harness.experimental_dispose();
    },
  );
});
