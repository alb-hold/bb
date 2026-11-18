export const WORKTREE_TRASH_DIR_NAME = ".trash";

const STAMP_PATTERN = /-(\d{8})T(\d{6})(\d{3})Z(?:-([0-9a-f]{16}))?$/u;

export interface WorktreeTrashEntryName {
  trashedAt: number;
  fingerprint: string | null;
}

function utcStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/gu, "").replace(".", "");
}

export function worktreeTrashEntryName(
  id: string,
  at: Date,
  fingerprint: string,
): string {
  return `${id.replace(/[^A-Za-z0-9._-]+/gu, "_")}-${utcStamp(at)}-${fingerprint}`;
}

export function parseWorktreeTrashEntryName(
  name: string,
): WorktreeTrashEntryName | null {
  const match = STAMP_PATTERN.exec(name);
  if (match === null || name.startsWith(".")) return null;
  const [, day, time, millis, fingerprint] = match;
  if (day === undefined || time === undefined || millis === undefined) {
    return null;
  }
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${millis}Z`;
  const at = Date.parse(iso);
  return Number.isNaN(at) || new Date(at).toISOString() !== iso
    ? null
    : { trashedAt: at, fingerprint: fingerprint ?? null };
}
