import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "__tests__",
  ".turbo",
  "build",
  "bundled-types",
]);
const childEntry =
  "packages/environment-provider-host/src/remove-tree-child.ts";
const ioModule = "packages/environment-provider-host/src/remove-tree-io.ts";
const syncIoModule =
  "packages/environment-provider-host/src/remove-tree-sync-io.ts";
const coreModule =
  "packages/environment-provider-host/src/remove-directory-tree-core.ts";
const worktreeModule = "plugins/environment-git-worktree/host/worktree.ts";
const testHookBranch =
  "if (Object.values(walkHooks).some((hook) => hook !== undefined))";

async function productionSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name))
        found.push(...(await productionSources(full)));
    } else if (
      /\.(ts|tsx|mts|cts|js|mjs)$/u.test(entry.name) &&
      !/\.(test|spec|test-d)\.[cm]?[jt]sx?$/u.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

interface Reference {
  file: string;
  line: number;
  text: string;
  call: boolean;
}

function references(file: string, source: string, name: RegExp): Reference[] {
  const lines = source.split("\n");
  const found: Reference[] = [];
  for (const match of source.matchAll(name)) {
    const offset = match.index;
    const line = source.slice(0, offset).split("\n").length;
    const after = source.slice(offset + match[0].length);
    found.push({
      file,
      line,
      text: lines[line - 1]!.trim(),
      call: /^\s*\(/u.test(after),
    });
  }
  return found;
}

function insideTestHookBranch(source: string, line: number): boolean {
  const lines = source.split("\n");
  for (let index = line - 2; index >= Math.max(0, line - 7); index -= 1)
    if (lines[index]!.trim() === testHookBranch) return true;
  return false;
}

it("keeps the synchronous tree walk reachable only from the removal child and the worktree test hooks", async () => {
  const files = (
    await Promise.all(
      ["apps", "packages", "plugins"].map((top) =>
        productionSources(path.join(repositoryRoot, top)),
      ),
    )
  ).flat();
  expect(files.length).toBeGreaterThan(100);
  const violations: string[] = [];
  const allowedCalls: Reference[] = [];
  for (const full of files) {
    const file = path.relative(repositoryRoot, full).split(path.sep).join("/");
    const source = await fs.readFile(full, "utf8");
    if (file !== childEntry && file !== syncIoModule) {
      for (const reference of [
        ...references(file, source, /remove-tree-sync-io/gu),
        ...references(file, source, /\bsyncRemoveTreeIo\b/gu),
      ])
        violations.push(
          `${file}:${reference.line} reaches the synchronous backend: ${reference.text}`,
        );
    }
    if (file !== childEntry && file !== ioModule) {
      for (const reference of references(
        file,
        source,
        /\binstallRemoveTreeIo\b/gu,
      ))
        violations.push(
          `${file}:${reference.line} replaces the tree backend: ${reference.text}`,
        );
    }
    if (file === coreModule) continue;
    for (const reference of references(
      file,
      source,
      /\b(removeDirectoryTree|inspectTreeBeforeMove)\b/gu,
    )) {
      const importSpecifier =
        /^(removeDirectoryTree|inspectTreeBeforeMove),?$/u.test(reference.text);
      if (importSpecifier) continue;
      const allowed =
        reference.call &&
        (file === childEntry ||
          (file === worktreeModule &&
            insideTestHookBranch(source, reference.line)));
      if (allowed) allowedCalls.push(reference);
      else
        violations.push(
          `${file}:${reference.line} walks the tree in the calling process: ${reference.text}`,
        );
    }
  }
  expect(violations).toEqual([]);
  expect(allowedCalls.map((reference) => reference.file).sort()).toEqual([
    childEntry,
    childEntry,
    worktreeModule,
    worktreeModule,
  ]);
});
