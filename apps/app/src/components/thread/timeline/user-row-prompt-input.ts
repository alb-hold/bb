import type { PromptInput } from "@bb/domain";
import type { TimelineConversationRow, TimelineRow } from "@bb/server-contract";

type UserConversationRow = Extract<TimelineConversationRow, { role: "user" }>;

export function userRowToPromptInput(
  row: UserConversationRow,
): PromptInput[] {
  const input: PromptInput[] = [];
  if (row.text.trim().length > 0) {
    input.push({ type: "text", text: row.text, mentions: [...row.mentions] });
  }
  for (const path of row.attachments?.localImagePaths ?? []) {
    input.push({ type: "localImage", path });
  }
  for (const path of row.attachments?.localFilePaths ?? []) {
    const detail = row.attachments?.localFileDetails.find(
      (file) => file.path === path,
    );
    input.push({
      type: "localFile",
      path,
      ...(detail ? { name: detail.name } : {}),
      ...(detail?.sizeBytes == null ? {} : { sizeBytes: detail.sizeBytes }),
    });
  }
  return input;
}

export function findLatestUndeliveredUserRow(
  rows: readonly TimelineRow[],
): UserConversationRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.kind === "turn" && row.children !== null) {
      const nested = findLatestUndeliveredUserRow(row.children);
      if (nested !== null) return nested;
      if (containsUserRow(row.children)) return null;
      continue;
    }
    if (row.kind === "conversation" && row.role === "user") {
      return row.role === "user" && row.turnRequest?.status === "undelivered"
        ? row
        : null;
    }
  }
  return null;
}

function containsUserRow(rows: readonly TimelineRow[]): boolean {
  return rows.some(
    (row) =>
      (row.kind === "conversation" && row.role === "user") ||
      (row.kind === "turn" &&
        row.children !== null &&
        containsUserRow(row.children)),
  );
}
