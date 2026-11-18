export const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;

export const REMOVE_DEADLINE_MS = REMOVE_TIMEOUT_MS - 60 * 1000;

export const REMOVE_STALL_MS = 60 * 1000;

export const REMOVE_KILL_GRACE_MS = 5 * 1000;

export const REMOVE_EXIT_WAIT_MS = 5 * 1000;

export function describeRemovalDuration(milliseconds: number): string {
  const unit =
    milliseconds >= 60_000 && milliseconds % 60_000 === 0
      ? { size: 60_000, name: "minute" }
      : { size: 1_000, name: "second" };
  const count = Math.max(1, Math.round(milliseconds / unit.size));
  return `${count} ${unit.name}${count === 1 ? "" : "s"}`;
}

export function removalDeadlineReason(deadlineMs: number): string {
  return `the removal did not finish within ${describeRemovalDuration(deadlineMs)}`;
}
