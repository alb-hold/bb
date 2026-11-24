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

async function readMountPoints(): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  const lines = text.trim().split("\n");
  if (lines[0] === "") return null;
  const points: string[] = [];
  for (const line of lines) {
    const field = line.split(" ")[4];
    if (field === undefined || !field.startsWith("/")) return null;
    points.push(
      field.replace(/\\(040|011|012|134)/gu, (_match, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    );
  }
  return points;
}

function containingMount(points: readonly string[], location: string): string {
  let deepest = "";
  for (const point of points)
    if (isPathWithinDirectory(point, location) && point.length > deepest.length)
      deepest = point;
  return deepest;
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

export async function temporaryTargetOnAnotherMount(
  requested: string,
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const points = await readMountPoints();
  if (points === null) return false;
  let temporaryRoot: string;
  try {
    temporaryRoot = await fs.realpath(os.tmpdir());
  } catch {
    return false;
  }
  const lexical = path.resolve(requested);
  if (!isPathWithinDirectory(temporaryRoot, lexical)) return false;
  return (
    containingMount(points, lexical) !== containingMount(points, temporaryRoot)
  );
}

export async function processDoubtsIgnorableForRemoval(
  requested: string,
  context: TemporaryRemovalContext,
  serverProtectedPaths: readonly string[] | undefined,
): Promise<boolean> {
  if (serverProtectedPaths === undefined) return false;
  if (process.platform !== "linux") return false;
  const points = await readMountPoints();
  if (points === null) return false;
  let temporaryRoot: string;
  try {
    temporaryRoot = await fs.realpath(os.tmpdir());
  } catch {
    return false;
  }
  const temporaryMount = containingMount(points, temporaryRoot);
  const lexical = path.resolve(requested);
  if (!isPathWithinDirectory(temporaryRoot, lexical)) return false;
  if (containingMount(points, lexical) !== temporaryMount) return false;
  let target: string;
  try {
    target = await fs.realpath(requested);
  } catch {
    return false;
  }
  if (target === temporaryRoot) return false;
  if (!isPathWithinDirectory(temporaryRoot, target)) return false;
  if (containingMount(points, target) !== temporaryMount) return false;
  if (points.some((point) => isPathWithinDirectory(target, point)))
    return false;
  if (target.split(path.sep).includes(".git")) return false;
  const protectedPaths = await Promise.all(
    [
      context.dataDir,
      context.threadStorageRootPath,
      ...context.runtimeManager.listLoadedWorkspacePaths(),
      ...serverProtectedPaths,
    ].map(canonical),
  );
  if (protectedPaths.some((protectedPath) => overlaps(protectedPath, target)))
    return false;
  for (
    let ancestor = path.dirname(target);
    ;
    ancestor = path.dirname(ancestor)
  ) {
    if ((await hasGitEntry(ancestor)) !== false) return false;
    if (ancestor === path.dirname(ancestor)) break;
  }
  return !(await treeHasGitEntry(target));
}
