import type { parsePatchFiles } from "@pierre/diffs";

export type GitDiffFileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed";

export type ParsedGitDiffFile = ReturnType<
  typeof parsePatchFiles
>[number]["files"][number];

export interface GitDiffStats {
  filesCount: number;
  insertions: number;
  deletions: number;
}

export function summarizeGitDiffFile(
  file: ParsedGitDiffFile,
): Pick<GitDiffStats, "insertions" | "deletions"> {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    insertions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { insertions, deletions };
}

export function getGitDiffFileChangeKind(
  file: ParsedGitDiffFile,
): GitDiffFileChangeKind {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
    default: {
      const _exhaustive: never = file.type;
      return _exhaustive;
    }
  }
}

export function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  const name = normalizeGitDiffPath(file.name) ?? file.name;
  const prevName = normalizeGitDiffPath(file.prevName);
  if (prevName && prevName !== name) {
    return `${prevName} -> ${name}`;
  }
  return name;
}

export function normalizeGitDiffPath(
  path: string | undefined,
): string | undefined {
  const trimmedPath = path?.trim();
  return trimmedPath && trimmedPath.length > 0 ? trimmedPath : undefined;
}

const IMAGE_GIT_DIFF_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export function isPreviewableImagePath(path: string | undefined): boolean {
  const normalizedPath = normalizeGitDiffPath(path);
  if (normalizedPath === undefined) return false;
  const extension = normalizedPath.split(".").pop()?.toLowerCase();
  return (
    extension !== undefined && IMAGE_GIT_DIFF_FILE_EXTENSIONS.has(extension)
  );
}

export function isSvgGitDiffFile(file: ParsedGitDiffFile): boolean {
  const path = normalizeGitDiffPath(file.name) ?? file.name;
  return path.toLowerCase().endsWith(".svg");
}

function getGitDiffPathAliases(path: string | undefined): string[] {
  const cleanPath = normalizeGitDiffPath(path);
  if (!cleanPath || cleanPath === "/dev/null") return [];
  const normalizedPath = cleanPath.startsWith("./")
    ? cleanPath.slice(2)
    : cleanPath;
  if (normalizedPath.length === 0) return [];
  const aliases = [normalizedPath];
  if (normalizedPath.startsWith("a/") || normalizedPath.startsWith("b/")) {
    aliases.push(normalizedPath.slice(2));
  }
  return Array.from(new Set(aliases.filter((alias) => alias.length > 0)));
}

export function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const candidatePath of [file.name, file.prevName]) {
    const aliases = getGitDiffPathAliases(candidatePath);
    if (aliases.length > 0) {
      return aliases[aliases.length - 1] ?? null;
    }
  }
  return null;
}
