import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathWithinDirectory } from "@bb/process-utils";
import type { CommandDispatchOptions } from "../command-dispatch-support.js";
import type { RuntimeManager } from "../runtime-manager.js";

const MAX_GIT_SEARCH_DIRECTORIES = 10_000;

export interface TemporaryRemovalContext {
  dataDir: CommandDispatchOptions["dataDir"];
  threadStorageRootPath: CommandDispatchOptions["threadStorageRootPath"];
  runtimeManager: Pick<RuntimeManager, "listLoadedWorkspacePaths">;
}

async function canonical(location: string): Promise<string> {
  try {
    return await fs.realpath(location);
  } catch {
    return path.resolve(location);
  }
}

function overlaps(protectedPath: string, target: string): boolean {
  return (
    isPathWithinDirectory(protectedPath, target) ||
    isPathWithinDirectory(target, protectedPath)
  );
}

async function hasGitEntry(directory: string): Promise<boolean | null> {
  try {
    await fs.lstat(path.join(directory, ".git"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    return null;
  }
}

async function mountInsideTarget(target: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return true;
  }
  const lines = text.trim().split("\n");
  if (lines[0] === "") return true;
  for (const line of lines) {
    const field = line.split(" ")[4];
    if (field === undefined || !field.startsWith("/")) return true;
    const point = field.replace(
      /\\(040|011|012|134)/gu,
      (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (isPathWithinDirectory(target, point)) return true;
  }
  return false;
}

async function treeHasGitEntry(root: string): Promise<boolean> {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    visited += 1;
    if (visited > MAX_GIT_SEARCH_DIRECTORIES) return true;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  return false;
}

export async function processDoubtsIgnorableForRemoval(
  requested: string,
  context: TemporaryRemovalContext,
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  let target: string;
  let temporaryRoot: string;
  try {
    [target, temporaryRoot] = await Promise.all([
      fs.realpath(requested),
      fs.realpath(os.tmpdir()),
    ]);
  } catch {
    return false;
  }
  if (target === temporaryRoot) return false;
  if (!isPathWithinDirectory(temporaryRoot, target)) return false;
  if (target.split(path.sep).includes(".git")) return false;
  const protectedPaths = await Promise.all(
    [
      context.dataDir,
      context.threadStorageRootPath,
      ...context.runtimeManager.listLoadedWorkspacePaths(),
    ].map(canonical),
  );
  if (protectedPaths.some((protectedPath) => overlaps(protectedPath, target)))
    return false;
  for (
    let ancestor = path.dirname(target);
    isPathWithinDirectory(temporaryRoot, ancestor);
    ancestor = path.dirname(ancestor)
  ) {
    if ((await hasGitEntry(ancestor)) !== false) return false;
  }
  if (await mountInsideTarget(target)) return false;
  return !(await treeHasGitEntry(target));
}
