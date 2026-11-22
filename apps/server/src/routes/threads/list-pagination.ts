import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "../../errors.js";

const cursorRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  createdAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
  pinSortKey: z.string().nullable(),
  pinnedAt: z.number().int().nullable(),
});

export function parseThreadCursor(cursor: string, archiveOrder: boolean) {
  try {
    const value = z
      .object({ archiveOrder: z.literal(archiveOrder), row: cursorRowSchema })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (!archiveOrder || value.row.archivedAt !== null) return value.row;
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid thread list cursor");
  }
  throw new ApiError(400, "invalid_request", "Invalid archived thread cursor");
}

export function finishThreadPage(
  context: Pick<Context, "header">,
  rows: z.infer<typeof cursorRowSchema>[],
  limit: number,
  archiveOrder: boolean,
) {
  context.header("X-BB-Pagination", "cursor");
  if (rows.length <= limit) return;
  rows.pop();
  const row = cursorRowSchema.parse(rows[limit - 1]);
  const cursor = Buffer.from(JSON.stringify({ archiveOrder, row })).toString(
    "base64url",
  );
  context.header("X-BB-Next-Cursor", cursor);
}

const sidebarCursorRowSchema = z.object({
  id: z.string(),
  pinnedAt: z.number().int().nullable(),
  pinSortKey: z.string().nullable(),
  isChild: z.boolean(),
  isActive: z.boolean(),
  latestAttentionAt: z.number().int(),
  createdAt: z.number().int(),
});

export function parseSidebarThreadCursor(cursor: string) {
  try {
    const value = z
      .object({
        sidebarOrder: z.literal(true),
        row: sidebarCursorRowSchema,
      })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return value.row;
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid thread list cursor");
  }
}

export function finishSidebarThreadPage<
  T extends {
    id: string;
    pinnedAt: number | null;
    pinSortKey: string | null;
    sidebarIsChild: boolean;
    status: string;
    latestAttentionAt: number;
    createdAt: number;
  },
>(context: Pick<Context, "header">, rows: T[], limit: number) {
  context.header("X-BB-Pagination", "cursor");
  if (rows.length <= limit) return;
  rows.pop();
  const last = rows[limit - 1];
  if (!last) return;
  const row = sidebarCursorRowSchema.parse({
    id: last.id,
    pinnedAt: last.pinnedAt,
    pinSortKey: last.pinSortKey,
    isChild: last.sidebarIsChild,
    isActive: last.status === "active",
    latestAttentionAt: last.latestAttentionAt,
    createdAt: last.createdAt,
  });
  const cursor = Buffer.from(
    JSON.stringify({ sidebarOrder: true, row }),
  ).toString("base64url");
  context.header("X-BB-Next-Cursor", cursor);
}
