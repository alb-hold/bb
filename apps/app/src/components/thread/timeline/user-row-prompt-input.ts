import type { PromptInput } from "@bb/domain";
import type { TimelineConversationRow, TimelineRow } from "@bb/server-contract";

type UserConversationRow = Extract<TimelineConversationRow, { role: "user" }>;

export function userRowToPromptInput(row: UserConversationRow): PromptInput[] {
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

export function findLatestUserRow(
  rows: readonly TimelineRow[],
): UserConversationRow | null {
  const laterTurnIds = new Set<string | null>();
  return searchLatestUserRow(rows, laterTurnIds);
}

function searchLatestUserRow(
  rows: readonly TimelineRow[],
  laterTurnIds: Set<string | null>,
): UserConversationRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.kind === "turn") {
      const nested =
        row.children === null
          ? null
          : searchLatestUserRow(row.children, laterTurnIds);
      if (nested !== null) return nested;
      laterTurnIds.add(row.turnId ?? null);
      continue;
    }
    if (row.kind === "conversation" && row.role === "user") {
      for (const turnId of laterTurnIds) {
        if (turnId !== (row.turnId ?? null)) return null;
      }
      return row;
    }
  }
  return null;
}
