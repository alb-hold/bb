export function isTmpRootOwnerProcess(
  startedAt: number | null,
  recordedAt: number,
  startTimeResolutionMs: number,
): boolean {
  return (
    startedAt === null ||
    startedAt <= recordedAt + startTimeResolutionMs
  );
}

export function isTmpRootOwnerIdentityLive(
  startedAt: number | null,
  recordedAt: number,
  startTimeResolutionMs: number,
  pidIsAlive: boolean,
): boolean {
  return startedAt === null
    ? pidIsAlive
    : isTmpRootOwnerProcess(startedAt, recordedAt, startTimeResolutionMs);
}

export function shouldCheckTmpRootOwnerPidLiveness(
  identity: { startedAt: number | null } | null,
): boolean {
  return identity === null || identity.startedAt === null;
}
