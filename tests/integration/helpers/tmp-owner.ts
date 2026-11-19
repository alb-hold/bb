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
