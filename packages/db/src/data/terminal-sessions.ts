import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notExists,
  or,
  type SQL,
} from "drizzle-orm";
import type {
  TerminalSessionCloseReason,
  TerminalSessionStatus,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createTerminalSessionId } from "../ids.js";
import {
  forkTerminalOutput,
  forkTerminalHolderSessions,
  forkTerminalTabDismissals,
  terminalSessions,
} from "../schema.js";

type TerminalSessionConnection = DbConnection | DbTransaction;

type StoredTerminalSessionRow = typeof terminalSessions.$inferSelect;
export type TerminalSessionRow = StoredTerminalSessionRow & {
  holderBacked: boolean;
};

export interface CreateTerminalSessionInput {
  cols: number;
  daemonSessionId: string | null;
  environmentId: string | null;
  hostId: string;
  id?: string;
  initialCwd: string;
  now?: number;
  rows: number;
  status: TerminalSessionStatus;
  threadId: string | null;
  title: string;
}

interface TerminalStatusScope {
  statuses?: readonly TerminalSessionStatus[];
}

export type TerminalSessionScope = TerminalStatusScope &
  (
    | { kind: "all" }
    | { daemonSessionId: string; kind: "daemon"; terminalId?: string }
    | { environmentId: string; kind: "environment" }
    | { hostId: string; kind: "host" }
    | { cwd: string | null; hostId: string; kind: "host-path" }
    | { kind: "terminal"; terminalId: string }
    | { kind: "thread"; threadId: string }
    | { environmentId: string; kind: "threadless-environment" }
  );

export type TerminalSessionSingleScope = TerminalStatusScope &
  (
    | { daemonSessionId: string; kind: "daemon"; terminalId: string }
    | { kind: "terminal"; terminalId: string }
  );

export type TerminalSessionMutation =
  | { kind: "disconnect"; retainDaemonSession: boolean }
  | { daemonSessionId: string; kind: "reconnect"; resetHolderBacked?: boolean }
  | {
      closeReason: TerminalSessionCloseReason;
      exitCode?: number | null;
      kind: "exit";
      retainDaemonSession?: boolean;
    }
  | {
      cols: number;
      daemonSessionId: string;
      initialCwd: string;
      kind: "running";
      rows: number;
      title: string;
    }
  | { cols: number; kind: "size"; rows: number }
  | { kind: "title"; title: string }
  | { kind: "holder-backed" }
  | { kind: "user-input" };

export interface ListTerminalSessionsArgs {
  scope: TerminalSessionScope;
  visible: boolean;
}

export interface UpdateTerminalSessionArgs {
  now?: number;
  scope: TerminalSessionSingleScope;
  update: TerminalSessionMutation;
}

export interface UpdateTerminalSessionsArgs {
  scope: TerminalSessionScope;
  update: TerminalSessionMutation;
}

export const NON_TERMINAL_SESSION_STATUSES: TerminalSessionStatus[] = [
  "starting",
  "running",
  "disconnected",
];

function terminalScope(
  scope: TerminalSessionScope,
  ...where: (SQL | undefined)[]
): SQL | undefined {
  let scoped: SQL | undefined;
  switch (scope.kind) {
    case "all":
      break;
    case "daemon":
      scoped = and(
        eq(terminalSessions.daemonSessionId, scope.daemonSessionId),
        scope.terminalId
          ? eq(terminalSessions.id, scope.terminalId)
          : undefined,
      );
      break;
    case "environment":
      scoped = eq(terminalSessions.environmentId, scope.environmentId);
      break;
    case "host":
      scoped = eq(terminalSessions.hostId, scope.hostId);
      break;
    case "host-path":
      scoped = and(
        eq(terminalSessions.hostId, scope.hostId),
        isNull(terminalSessions.threadId),
        isNull(terminalSessions.environmentId),
        scope.cwd === null
          ? undefined
          : eq(terminalSessions.initialCwd, scope.cwd),
      );
      break;
    case "terminal":
      scoped = eq(terminalSessions.id, scope.terminalId);
      break;
    case "thread":
      scoped = eq(terminalSessions.threadId, scope.threadId);
      break;
    case "threadless-environment":
      scoped = and(
        eq(terminalSessions.environmentId, scope.environmentId),
        isNull(terminalSessions.threadId),
      );
      break;
  }
  return and(
    scoped,
    scope.statuses
      ? inArray(terminalSessions.status, [...scope.statuses])
      : undefined,
    ...where,
  );
}

function mutationValues(
  update: TerminalSessionMutation,
  now: number,
): Partial<typeof terminalSessions.$inferInsert> {
  switch (update.kind) {
    case "disconnect":
      return {
        ...(update.retainDaemonSession ? {} : { daemonSessionId: null }),
        status: "disconnected",
        updatedAt: now,
      };
    case "reconnect":
      return {
        daemonSessionId: update.daemonSessionId,
        status: "running",
        updatedAt: now,
      };
    case "exit":
      return {
        closeReason: update.closeReason,
        ...(update.retainDaemonSession ? {} : { daemonSessionId: null }),
        ...(update.exitCode === undefined ? {} : { exitCode: update.exitCode }),
        status: "exited",
        updatedAt: now,
      };
    case "running":
      return {
        closeReason: null,
        cols: update.cols,
        daemonSessionId: update.daemonSessionId,
        exitCode: null,
        initialCwd: update.initialCwd,
        rows: update.rows,
        status: "running",
        title: update.title,
        updatedAt: now,
      };
    case "size":
      return { cols: update.cols, rows: update.rows, updatedAt: now };
    case "title":
      return { title: update.title, updatedAt: now };
    case "holder-backed":
      return { updatedAt: now };
    case "user-input":
      return { lastUserInputAt: now, updatedAt: now };
  }
}

function withHolderBacked(
  db: TerminalSessionConnection,
  rows: StoredTerminalSessionRow[],
): TerminalSessionRow[] {
  if (rows.length === 0) return [];
  const holderBackedIds = new Set(
    db
      .select({
        terminalSessionId: forkTerminalHolderSessions.terminalSessionId,
      })
      .from(forkTerminalHolderSessions)
      .where(
        inArray(
          forkTerminalHolderSessions.terminalSessionId,
          rows.map((row) => row.id),
        ),
      )
      .all()
      .map((row) => row.terminalSessionId),
  );
  return rows.map((row) => ({
    ...row,
    holderBacked: holderBackedIds.has(row.id),
  }));
}

function clearHolderBacked(
  db: TerminalSessionConnection,
  terminalIds: string[],
): void {
  if (terminalIds.length === 0) return;
  db.delete(forkTerminalHolderSessions)
    .where(inArray(forkTerminalHolderSessions.terminalSessionId, terminalIds))
    .run();
}

function markHolderBacked(
  db: TerminalSessionConnection,
  terminalIds: string[],
  confirmedAt: number,
): void {
  if (terminalIds.length === 0) return;
  db.insert(forkTerminalHolderSessions)
    .values(terminalIds.map((terminalSessionId) => ({
      terminalSessionId,
      confirmedAt,
    })))
    .onConflictDoNothing()
    .run();
}

function mutationWhere(update: TerminalSessionMutation): SQL | undefined {
  return update.kind === "user-input"
    ? isNull(terminalSessions.lastUserInputAt)
    : undefined;
}

export function createTerminalSession(
  db: TerminalSessionConnection,
  input: CreateTerminalSessionInput,
): TerminalSessionRow {
  const now = input.now ?? Date.now();
  const row = db
    .insert(terminalSessions)
    .values({
      id: input.id ?? createTerminalSessionId(),
      threadId: input.threadId,
      environmentId: input.environmentId,
      hostId: input.hostId,
      daemonSessionId: input.daemonSessionId,
      title: input.title,
      initialCwd: input.initialCwd,
      cols: input.cols,
      rows: input.rows,
      status: input.status,
      exitCode: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      lastUserInputAt: null,
    })
    .returning()
    .get();
  return { ...row, holderBacked: false };
}

export function listTerminalSessions(
  db: TerminalSessionConnection,
  args: ListTerminalSessionsArgs,
): TerminalSessionRow[] {
  const rows = db
    .select()
    .from(terminalSessions)
    .where(
      terminalScope(
        args.scope,
        args.visible
          ? or(
              inArray(terminalSessions.status, NON_TERMINAL_SESSION_STATUSES),
              and(
                eq(terminalSessions.status, "exited"),
                exists(
                  db
                    .select({
                      terminalSessionId: forkTerminalOutput.terminalSessionId,
                    })
                    .from(forkTerminalOutput)
                    .where(
                      and(
                        eq(
                          forkTerminalOutput.terminalSessionId,
                          terminalSessions.id,
                        ),
                        gt(forkTerminalOutput.expiresAt, Date.now()),
                      ),
                    ),
                ),
                notExists(
                  db
                    .select({
                      terminalSessionId:
                        forkTerminalTabDismissals.terminalSessionId,
                    })
                    .from(forkTerminalTabDismissals)
                    .where(
                      and(
                        eq(
                          forkTerminalTabDismissals.terminalSessionId,
                          terminalSessions.id,
                        ),
                        eq(
                          forkTerminalTabDismissals.hostId,
                          terminalSessions.hostId,
                        ),
                      ),
                    ),
                ),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(terminalSessions.createdAt), asc(terminalSessions.id))
    .all();
  return withHolderBacked(db, rows);
}

export function countTerminalSessions(
  db: TerminalSessionConnection,
  args: ListTerminalSessionsArgs,
): number {
  return db
    .select({ count: count() })
    .from(terminalSessions)
    .where(
      terminalScope(
        args.scope,
        args.visible
          ? inArray(terminalSessions.status, NON_TERMINAL_SESSION_STATUSES)
          : undefined,
      ),
    )
    .get()!.count;
}

export function getTerminalSession(
  db: TerminalSessionConnection,
  scope: TerminalSessionSingleScope,
): TerminalSessionRow | null {
  const row = db
    .select()
    .from(terminalSessions)
    .where(terminalScope(scope))
    .get();
  return row === undefined ? null : (withHolderBacked(db, [row])[0] ?? null);
}

export function updateTerminalSession(
  db: TerminalSessionConnection,
  args: UpdateTerminalSessionArgs,
): TerminalSessionRow | null {
  const now = args.now ?? Date.now();
  const row = db
    .update(terminalSessions)
    .set(mutationValues(args.update, now))
    .where(terminalScope(args.scope, mutationWhere(args.update)))
    .returning()
    .get();
  if (row === undefined) return null;
  if (args.update.kind === "holder-backed") {
    markHolderBacked(db, [row.id], now);
  } else if (
    args.update.kind === "exit" ||
    (args.update.kind === "reconnect" && args.update.resetHolderBacked)
  ) {
    clearHolderBacked(db, [row.id]);
  }
  return withHolderBacked(db, [row])[0] ?? null;
}

export function updateTerminalSessions(
  db: TerminalSessionConnection,
  args: UpdateTerminalSessionsArgs,
): TerminalSessionRow[] {
  const now = Date.now();
  const rows = db
    .update(terminalSessions)
    .set(mutationValues(args.update, now))
    .where(terminalScope(args.scope, mutationWhere(args.update)))
    .returning()
    .all();
  if (args.update.kind === "holder-backed") {
    markHolderBacked(db, rows.map((row) => row.id), now);
  } else if (
    args.update.kind === "exit" ||
    (args.update.kind === "reconnect" && args.update.resetHolderBacked)
  ) {
    clearHolderBacked(db, rows.map((row) => row.id));
  }
  return withHolderBacked(db, rows);
}
