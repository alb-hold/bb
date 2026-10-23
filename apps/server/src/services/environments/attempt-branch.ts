export function attemptNumberFromPathKey(
  pathKey: string,
  threadId: string,
): number {
  const prefix = `${threadId}-`;
  if (!pathKey.startsWith(prefix)) return 1;
  const tail = pathKey.slice(prefix.length);
  return /^\d+$/u.test(tail) ? Math.max(1, Number(tail)) : 1;
}

export function attemptBranchName(
  branchName: string,
  threadId: string,
  attempt: number,
): string {
  if (attempt <= 1 || !branchName.endsWith(threadId)) return branchName;
  return `${branchName.slice(0, branchName.length - threadId.length)}r${attempt}-${threadId}`;
}
