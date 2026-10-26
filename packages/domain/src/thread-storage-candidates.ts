import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
  isRawThreadId,
} from "./raw-thread-id.js";

export interface ThreadStorageListingEntry {
  name: string;
  kind: string;
}

const worktreeFolderPattern = new RegExp(
  `^(thr_[${GENERATED_ID_ALPHABET}]{${GENERATED_ID_SUFFIX_LENGTH}})(?:-[0-9]+)?$`,
  "u",
);

export function listThreadStorageIds(
  entries: readonly ThreadStorageListingEntry[],
): string[] {
  return entries
    .filter((entry) => entry.kind === "directory" && isRawThreadId(entry.name))
    .map((entry) => entry.name);
}

export function withoutThreadRows(
  ids: readonly string[],
  idsWithRows: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => !idsWithRows.has(id));
}

export function threadIdOfWorktreeFolder(name: string): string | null {
  return worktreeFolderPattern.exec(name)?.[1] ?? null;
}
