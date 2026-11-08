import { internal_DO_NOT_USE_loadGitDiffParser } from "@get-bb/plugin-sdk/app";
import type { parseGitDiffFiles } from "./git-diff-parsing";

type GitDiffParser = { parseGitDiffFiles: typeof parseGitDiffFiles };
let pending: Promise<GitDiffParser> | null = null;

export function loadGitDiffParser(): Promise<GitDiffParser> {
  pending ??= internal_DO_NOT_USE_loadGitDiffParser()
    .then((module) => {
      if (
        typeof module !== "object" ||
        module === null ||
        !("parseGitDiffFiles" in module) ||
        typeof module.parseGitDiffFiles !== "function"
      )
        throw new Error("Git diff parser is unavailable");
      return module as GitDiffParser;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
