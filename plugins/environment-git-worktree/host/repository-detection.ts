import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  descriptorPath,
  sameDirectory,
} from "bb-environment-provider-host/remove-directory-tree";

export const REPOSITORY_SCAN_BUDGET_MS = 10_000;
const NAMED_LIMIT = 5;
const SUBMODULE_MODE = "160000 ";

export interface RepositoryScanHooks {
  budgetMs?: number;
  beforeDirectoryOpen?: (directory: string) => Promise<void>;
  readDirectoryNames?: (directory: string) => Promise<string[]>;
}

export interface IndexListing {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function lstatUnlessGone(target: string): Promise<Stats | null> {
  return fs.lstat(target).then(
    (info) => info,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    },
  );
}

function namedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMED_LIMIT).join(", ");
  const more = paths.length - NAMED_LIMIT;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function isSpecialFile(info: Stats): boolean {
  return (
    info.isFIFO() ||
    info.isSocket() ||
    info.isCharacterDevice() ||
    info.isBlockDevice()
  );
}

async function hasRepositoryShape(
  directory: string,
  names: readonly string[],
): Promise<boolean> {
  if (!names.includes("HEAD")) return false;
  const head = await lstatUnlessGone(path.join(directory, "HEAD"));
  if (head === null || head.isDirectory()) return false;
  if (isSpecialFile(head)) return true;
  const objects = names.includes("objects")
    ? await lstatUnlessGone(path.join(directory, "objects"))
    : null;
  const commondir = names.includes("commondir")
    ? await lstatUnlessGone(path.join(directory, "commondir"))
    : null;
  const refs = names.includes("refs")
    ? await lstatUnlessGone(path.join(directory, "refs"))
    : null;
  return (
    (objects?.isDirectory() === true || commondir !== null) &&
    refs?.isDirectory() === true
  );
}

export async function findNestedRepositories(
  root: string,
  hooks: RepositoryScanHooks = {},
): Promise<{ repositories: string[] } | { failure: string }> {
  const budgetMs = hooks.budgetMs ?? REPOSITORY_SCAN_BUDGET_MS;
  const readDirectoryNames =
    hooks.readDirectoryNames ?? ((directory: string) => fs.readdir(directory));
  const started = performance.now();
  const repositories: string[] = [];
  const pending: string[] = [""];
  for (
    let relative = pending.pop();
    relative !== undefined;
    relative = pending.pop()
  ) {
    if (performance.now() - started > budgetMs)
      return { failure: `it took longer than ${budgetMs} ms` };
    const entry = path.join(root, relative);
    try {
      const before = await lstatUnlessGone(entry);
      if (before === null) {
        if (relative === "") return { failure: `${root} is gone` };
        continue;
      }
      if (!before.isDirectory()) continue;
      await hooks.beforeDirectoryOpen?.(entry);
      const handle = await fs.open(
        entry,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let names: string[];
      try {
        if (!sameDirectory(before, await handle.stat()))
          return { failure: `${entry} was replaced while it was checked` };
        const anchored = await descriptorPath(
          handle,
          (candidate) => fs.stat(candidate),
          readDirectoryNames,
        );
        if (anchored === null)
          return { failure: `could not open ${entry} by its descriptor` };
        names = await readDirectoryNames(anchored);
      } finally {
        await handle.close();
      }
      if (relative !== "") {
        if (
          names.includes(".git") ||
          (await hasRepositoryShape(entry, names))
        ) {
          repositories.push(relative);
          continue;
        }
      }
      for (const name of names)
        if (relative !== "" || name !== ".git")
          pending.push(path.join(relative, name));
    } catch (error) {
      if (errorCode(error) === "ENOENT" && relative !== "") continue;
      return { failure: describeError(error) };
    }
  }
  return { repositories: repositories.sort() };
}

async function moduleRepositoryReasons(gitDir: string): Promise<string[]> {
  const modules = path.join(gitDir, "modules");
  try {
    const info = await lstatUnlessGone(modules);
    if (info === null) return [];
    if (!info.isDirectory())
      return [
        `has a modules entry in its Git metadata that is a ${info.isSymbolicLink() ? "symbolic link" : "file"}, not a directory`,
      ];
    const entries = (await fs.readdir(modules)).sort();
    if (entries.length === 0) return [];
    return [
      `has submodule repositories in its Git metadata (${namedPaths(entries.map((name) => `modules/${name}`))}), and removing the worktree would delete them with any unpushed commits`,
    ];
  } catch (error) {
    return [
      `could not check for submodule repositories (${describeError(error)})`,
    ];
  }
}

async function gitlinkReason(
  worktree: string,
  gitlink: string,
): Promise<string | null> {
  try {
    const parts = gitlink.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const component = await lstatUnlessGone(
        path.join(worktree, ...parts.slice(0, depth)),
      );
      if (component === null) return null;
      if (component.isSymbolicLink())
        return `has a submodule path ${gitlink} that passes through a symbolic link`;
    }
    const marker = await lstatUnlessGone(path.join(worktree, gitlink, ".git"));
    if (marker === null) return null;
    if (marker.isDirectory())
      return `has a submodule at ${gitlink} whose repository is inside the worktree (${gitlink}/.git) and would be deleted with it`;
    return `has an initialized submodule at ${gitlink}, whose files would be deleted with the worktree`;
  } catch (error) {
    return `could not check submodule ${gitlink} (${describeError(error)})`;
  }
}

export async function findRepositoryReasons(args: {
  worktree: string;
  gitDir: string;
  index: IndexListing;
  scan?: RepositoryScanHooks;
}): Promise<string[]> {
  const reasons = await moduleRepositoryReasons(args.gitDir);
  const reported = new Set<string>();
  if (args.index.exitCode !== 0) {
    const detail = args.index.stderr.trim();
    reasons.push(
      `could not read its index to look for submodules${detail === "" ? "" : ` (${detail})`}`,
    );
  } else {
    for (const entry of args.index.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (!entry.startsWith(SUBMODULE_MODE) || tab === -1) continue;
      const gitlink = entry.slice(tab + 1);
      const reason = await gitlinkReason(args.worktree, gitlink);
      if (reason === null) continue;
      reasons.push(reason);
      reported.add(gitlink);
    }
  }
  const nested = await findNestedRepositories(args.worktree, args.scan);
  if ("failure" in nested) {
    reasons.push(
      `could not finish checking for git repositories inside the worktree (${nested.failure})`,
    );
  } else {
    const unreported = nested.repositories.filter(
      (repository) => !reported.has(repository.split(path.sep).join("/")),
    );
    if (unreported.length > 0)
      reasons.push(
        `has a git repository inside the worktree at ${namedPaths(unreported)}`,
      );
  }
  return reasons;
}
