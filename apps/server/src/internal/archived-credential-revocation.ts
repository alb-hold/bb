import { and, desc, eq } from "drizzle-orm";
import { events } from "@bb/db";
import { providerErrorInfoSchema } from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../types.js";

const terminalProviderErrorDataSchema = z.object({
  willRetry: z.boolean().optional(),
  errorInfo: providerErrorInfoSchema.optional(),
});

export function isArchivedCredentialRevocation(
  db: AppDeps["db"],
  threadId: string,
  turnId: string,
  archivedAt: number,
): boolean {
  const turnStart = db
    .select({
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, turnId),
        eq(events.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  const latestProviderError = db
    .select({ createdAt: events.createdAt, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, turnId),
        eq(events.type, "provider/error"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  let isUnauthorized = false;
  try {
    const terminalError = terminalProviderErrorDataSchema.safeParse(
      JSON.parse(latestProviderError?.data ?? "null"),
    );
    isUnauthorized =
      terminalError.success &&
      terminalError.data.willRetry !== true &&
      terminalError.data.errorInfo?.category === "unauthorized";
  } catch {
    isUnauthorized = false;
  }
  return (
    turnStart !== undefined &&
    turnStart.createdAt <= archivedAt &&
    latestProviderError !== undefined &&
    latestProviderError.createdAt >= archivedAt &&
    isUnauthorized
  );
}
