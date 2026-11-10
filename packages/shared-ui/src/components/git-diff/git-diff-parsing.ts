import { parsePatchFiles, processFile, type FileContents } from "@pierre/diffs";

import {
  normalizeGitDiffPath,
  type ParsedGitDiffFile,
} from "./git-diff-metadata";
export * from "./git-diff-metadata";

export function parseGitDiffFiles(
  diff: string,
): ReturnType<typeof parsePatchFiles>[number]["files"] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

interface NormalizedFilePatch {
  patch: string;
  file: ParsedGitDiffFile;
}

export function normalizeFilePatch({
  patch,
  path,
}: {
  patch: string;
  path: string;
}): NormalizedFilePatch | null {
  const normalizedPatch = patch.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (normalizedPatch.trim().length === 0) return null;
  const normalizedPath = normalizeGitDiffPath(path) ?? path;
  const isGitDiff = normalizedPatch.startsWith("diff --git");
  const patchText = isGitDiff
    ? `${normalizedPatch}\n`
    : `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${normalizedPatch}\n`;
  const file = parseGitDiffFiles(patchText)[0];
  if (file === undefined || (!isGitDiff && file.hunks.length === 0)) {
    return null;
  }
  return { patch: patchText, file };
}

interface GitDiffContextEnrichmentInput {
  fileDiff: ParsedGitDiffFile;
  oldFile: FileContents;
  newFile: FileContents;
  patchText?: string;
}

export function enrichGitDiffFileForContext({
  fileDiff,
  oldFile,
  newFile,
  patchText,
}: GitDiffContextEnrichmentInput): ParsedGitDiffFile {
  if (!patchText || !doFullFilePathsMatch(fileDiff, oldFile, newFile)) {
    return fileDiff;
  }

  const enrichedFile = processFile(patchText, { oldFile, newFile });
  if (
    enrichedFile === undefined ||
    enrichedFile.isPartial ||
    !doFullFileHunksMatch(fileDiff, enrichedFile)
  ) {
    return fileDiff;
  }
  return enrichedFile;
}

function doFullFilePathsMatch(
  fileDiff: ParsedGitDiffFile,
  oldFile: FileContents,
  newFile: FileContents,
): boolean {
  const expectedNewPath = normalizeGitDiffPath(fileDiff.name);
  const expectedOldPath =
    normalizeGitDiffPath(fileDiff.prevName) ?? expectedNewPath;
  return (
    expectedOldPath !== undefined &&
    expectedNewPath !== undefined &&
    normalizeGitDiffPath(oldFile.name) === expectedOldPath &&
    normalizeGitDiffPath(newFile.name) === expectedNewPath
  );
}

function doFullFileHunksMatch(
  partialFile: ParsedGitDiffFile,
  fullFile: ParsedGitDiffFile,
): boolean {
  return partialFile.hunks.every(
    (hunk) =>
      doLineRangesMatch({
        expectedLines: partialFile.deletionLines,
        expectedStart: hunk.deletionLineIndex,
        actualLines: fullFile.deletionLines,
        actualStart: hunk.deletionStart - 1,
        count: hunk.deletionCount,
      }) &&
      doLineRangesMatch({
        expectedLines: partialFile.additionLines,
        expectedStart: hunk.additionLineIndex,
        actualLines: fullFile.additionLines,
        actualStart: hunk.additionStart - 1,
        count: hunk.additionCount,
      }),
  );
}

function doLineRangesMatch({
  expectedLines,
  expectedStart,
  actualLines,
  actualStart,
  count,
}: {
  expectedLines: string[];
  expectedStart: number;
  actualLines: string[];
  actualStart: number;
  count: number;
}): boolean {
  if (
    expectedStart < 0 ||
    actualStart < 0 ||
    count < 0 ||
    expectedStart + count > expectedLines.length ||
    actualStart + count > actualLines.length
  ) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    if (
      normalizeComparableDiffLine(expectedLines[expectedStart + index]) !==
      normalizeComparableDiffLine(actualLines[actualStart + index])
    ) {
      return false;
    }
  }
  return true;
}

function normalizeComparableDiffLine(line: string | undefined): string {
  return line?.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : (line ?? "");
}
