const ATTEMPT_SEPARATOR = ".r";

function endsAtBoundary(branch: string, tail: string): boolean {
  if (!branch.endsWith(tail)) return false;
  const before = branch.slice(0, branch.length - tail.length);
  return before === "" || before.endsWith("/") || before.endsWith("-");
}

export function attemptBranchName(
  suggestedBranchName: string,
  threadId: string,
  attempt: number,
): string | null {
  if (!endsAtBoundary(suggestedBranchName, threadId)) return null;
  return attempt <= 1
    ? suggestedBranchName
    : `${suggestedBranchName}${ATTEMPT_SEPARATOR}${attempt}`;
}

export function branchBelongsToAttempt(
  branch: string,
  threadId: string,
  attempt: number,
): boolean {
  return attempt <= 1
    ? endsAtBoundary(branch, threadId)
    : endsAtBoundary(branch, `${threadId}${ATTEMPT_SEPARATOR}${attempt}`);
}
