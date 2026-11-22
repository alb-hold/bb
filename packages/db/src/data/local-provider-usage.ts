import { sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;
const FIVE_HOUR_MS = FIVE_HOUR_MINUTES * 60 * 1_000;
const SEVEN_DAY_MS = SEVEN_DAY_MINUTES * 60 * 1_000;

export interface LocalProviderUsageWindowSummary {
  label: string;
  windowMinutes: number;
  tokens: number;
  turns: number;
}

export interface LocalProviderUsageSummary {
  hasThreads: boolean;
  lastActivityAt: number | null;
  windows: LocalProviderUsageWindowSummary[];
}

interface StoredUsageEventRow {
  type: string;
  sequence: number;
  createdAt: number;
  providerThreadId: string | null;
  data: string;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readTokenUsageEvent(data: Record<string, unknown>): {
  lastTotalTokens: number;
  cumulativeTotalTokens: number;
} | null {
  const tokenUsage = data["tokenUsage"];
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;
  const record = tokenUsage as Record<string, unknown>;
  const last = record["last"];
  const total = record["total"];
  const lastTokens =
    typeof last === "object" && last !== null
      ? asNonNegativeInt((last as Record<string, unknown>)["totalTokens"])
      : null;
  const totalTokens =
    typeof total === "object" && total !== null
      ? asNonNegativeInt((total as Record<string, unknown>)["totalTokens"])
      : null;
  if (lastTokens === null && totalTokens === null) return null;
  return {
    lastTotalTokens: lastTokens ?? 0,
    cumulativeTotalTokens: totalTokens ?? 0,
  };
}

function readContextWindowUsedTokens(
  data: Record<string, unknown>,
): number | null {
  const usage = data["contextWindowUsage"];
  if (typeof usage !== "object" || usage === null) return null;
  return asNonNegativeInt((usage as Record<string, unknown>)["usedTokens"]);
}

export function summarizeLocalProviderUsage(
  db: DbQueryConnection,
  args: { providerId: string; now?: number },
): LocalProviderUsageSummary {
  const now = args.now ?? Date.now();
  const cutoff5h = now - FIVE_HOUR_MS;
  const cutoff7d = now - SEVEN_DAY_MS;

  const threadRows = db.all<{ id: string }>(
    sql`SELECT id FROM threads
        WHERE provider_id = ${args.providerId}
          AND updated_at >= ${cutoff7d}`,
  );

  let tokens5h = 0;
  let tokens7d = 0;
  let turns5h = 0;
  let turns7d = 0;
  let lastActivityAt: number | null = null;

  const noteActivity = (timestamp: number) => {
    if (timestamp >= cutoff7d) {
      lastActivityAt =
        lastActivityAt === null ? timestamp : Math.max(lastActivityAt, timestamp);
    }
  };

  const USAGE_EVENT_TYPES = [
    "thread/tokenUsage/updated",
    "thread/contextWindowUsage/updated",
    "turn/completed",
  ] as const;

  for (const { id: threadId } of threadRows) {
    const events: StoredUsageEventRow[] = [];
    for (const eventType of USAGE_EVENT_TYPES) {
      const rows = db.all<StoredUsageEventRow>(
        sql`SELECT type,
                   sequence,
                   created_at AS createdAt,
                   provider_thread_id AS providerThreadId,
                   data
            FROM events
            WHERE thread_id = ${threadId}
              AND type = ${eventType}
            ORDER BY sequence ASC`,
      );
      events.push(...rows);
    }
    events.sort((a, b) => a.sequence - b.sequence);

    const hasTokenUsageEvents = events.some(
      (event) => event.type === "thread/tokenUsage/updated",
    );

    const prevTokenTotals = new Map<string, number>();
    const prevContextUsed = new Map<string, number>();
    let threadTokens5h = 0;
    let threadTokens7d = 0;
    let threadTurns5h = 0;
    let threadTurns7d = 0;

    for (const event of events) {
      if (event.type === "turn/completed") {
        if (event.createdAt >= cutoff7d) {
          threadTurns7d += 1;
          noteActivity(event.createdAt);
        }
        if (event.createdAt >= cutoff5h) {
          threadTurns5h += 1;
        }
        continue;
      }

      const data = parseJsonObject(event.data);
      if (data === null) continue;
      const sessionKey =
        event.providerThreadId ??
        (typeof data["providerThreadId"] === "string"
          ? data["providerThreadId"]
          : "");

      if (hasTokenUsageEvents) {
        if (event.type !== "thread/tokenUsage/updated") continue;
        const parsed = readTokenUsageEvent(data);
        if (parsed === null) continue;
        const prevTotal = prevTokenTotals.get(sessionKey) ?? 0;
        const isRepeat =
          parsed.cumulativeTotalTokens > 0 &&
          parsed.cumulativeTotalTokens === prevTotal;
        if (parsed.cumulativeTotalTokens > 0) {
          prevTokenTotals.set(sessionKey, parsed.cumulativeTotalTokens);
        }
        if (isRepeat || parsed.lastTotalTokens <= 0) continue;
        if (event.createdAt >= cutoff7d) {
          threadTokens7d += parsed.lastTotalTokens;
          noteActivity(event.createdAt);
        }
        if (event.createdAt >= cutoff5h) {
          threadTokens5h += parsed.lastTotalTokens;
        }
      } else if (event.type === "thread/contextWindowUsage/updated") {
        const usedTokens = readContextWindowUsedTokens(data);
        if (usedTokens === null) continue;
        const prevUsed = prevContextUsed.get(sessionKey);
        const delta =
          prevUsed === undefined
            ? usedTokens
            : usedTokens > prevUsed
              ? usedTokens - prevUsed
              : usedTokens < prevUsed
                ? usedTokens
                : 0;
        prevContextUsed.set(sessionKey, usedTokens);
        if (delta <= 0) continue;
        if (event.createdAt >= cutoff7d) {
          threadTokens7d += delta;
          noteActivity(event.createdAt);
        }
        if (event.createdAt >= cutoff5h) {
          threadTokens5h += delta;
        }
      }
    }

    tokens5h += threadTokens5h;
    tokens7d += threadTokens7d;
    turns5h += threadTurns5h > 0 ? threadTurns5h : threadTokens5h > 0 ? 1 : 0;
    turns7d += threadTurns7d > 0 ? threadTurns7d : threadTokens7d > 0 ? 1 : 0;
  }

  return {
    hasThreads: threadRows.length > 0,
    lastActivityAt,
    windows: [
      {
        label: "5 hour",
        windowMinutes: FIVE_HOUR_MINUTES,
        tokens: tokens5h,
        turns: turns5h,
      },
      {
        label: "7 day",
        windowMinutes: SEVEN_DAY_MINUTES,
        tokens: tokens7d,
        turns: turns7d,
      },
    ],
  };
}
