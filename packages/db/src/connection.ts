import Database from "better-sqlite3";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { hrtime, resourceUsage, threadCpuUsage } from "node:process";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { registerHostPathSqlFunctions } from "./data/host-path-sql.js";
import {
  createWalSampler,
  finishQueryDiagnostics,
  type QueryDiagnosticsLogFields,
} from "./query-diagnostics.js";
import * as schema from "./schema.js";
import { classifyStatementReader } from "./statement-lock-wait-source.js";

export interface SlowDbQueryLogFields {
  bindingArgumentCount: number;
  callers?: string[];
  durationMs: number;
  lockWaitMs?: number;
  lockWaitSource?: "begin" | "first-write" | "exec" | "unknown" | "none";
  bodyMs?: number;
  cpuDurationMs: number;
  eventLoopWork: string | null;
  operation: SlowDbQueryOperation;
  sql: string;
  thresholdMs: number;
  diagnostics?: QueryDiagnosticsLogFields;
  requestShape?: ThreadListRequestShape;
  clientKind?: ThreadListClientKind;
}

export interface ThreadListRequestShape {
  includeHidden: boolean;
  archived: "true" | "false" | "absent";
  filters: string[];
  limit: number | null;
  offset: number | null;
}

export interface ThreadListClientKind {
  appSurface: "api" | "cli" | "desktop" | "mobile" | "web";
  userAgentKind: "node" | "browser" | "other" | "missing";
  pluginId?: string;
}

export interface SlowDbQueryLogger {
  info(fields: SlowDbQueryLogFields, message: string): void;
}

export interface DbSynchronousWorkTracker {
  run<T>(label: () => string, work: () => T): T;
  record(label: () => string, durationMs: number, cpuMs: number): void;
}

export interface QueryPlanExecutionObserver {
  observeFirstExecution(source: string, params: readonly unknown[]): void;
}

export type DatabaseWriteByteSource =
  | "event-append"
  | "event-prune-delete"
  | "wal-checkpoint";

export interface DatabaseWriteBytesLogFields {
  bytes: number;
  source: DatabaseWriteByteSource;
}

export interface DatabaseWriteBytesLogger {
  debug(fields: DatabaseWriteBytesLogFields, message: string): void;
}

export interface CreateConnectionOptions {
  databaseWriteBytesLogger?: DatabaseWriteBytesLogger;
  slowQueryLogger?: SlowDbQueryLogger;
  synchronousWorkTracker?: DbSynchronousWorkTracker;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryWorkLabel?: () => string | null;
  slowQueryDiagnosticsEnabled?: () => boolean;
  queryPlanObserver?: () => QueryPlanExecutionObserver | null;
}

export type DbConnection = ReturnType<typeof createConnection>;
export type DbTransaction = Parameters<
  Parameters<DbConnection["transaction"]>[0]
>[0];
export type DbQueryConnection = DbConnection | DbTransaction;
export type SlowDbQueryOperation =
  | "all"
  | "get"
  | "run"
  | "exec"
  | "transaction";

const databaseWriteBytesLoggers = new WeakMap<
  object,
  DatabaseWriteBytesLogger
>();

interface SlowDbQueryConfig {
  activeTransaction: TransactionWorkState | null;
  tracker: DbSynchronousWorkTracker | null;
  queryPlanObserver: () => QueryPlanExecutionObserver | null;
  logger: SlowDbQueryLogger | null;
  thresholdMs: number | (() => number);
  workLabel: () => string | null;
  walPath: string | null;
  sampleWal: () => QueryDiagnosticsLogFields["wal"];
  diagnosticsEnabled: () => boolean;
  transactionDepth: number;
  transactionLockWaitMs: number;
  transactionLockWaitSource: "begin" | "first-write" | "exec" | "unknown" | null;
  transactionStartNs: bigint | null;
}

const compiledQueries = new WeakMap<
  DbQueryConnection,
  Map<(db: DbQueryConnection) => unknown, unknown>
>();

type CommitContext = { pending: Array<() => void> | undefined };
const commitContexts = new WeakMap<DbQueryConnection, CommitContext>();

export function afterCommit(db: DbQueryConnection, callback: () => void): void {
  const pending = commitContexts.get(db)?.pending;
  if (pending) pending.push(callback);
  else callback();
}

export function prepareCachedQuery<TQuery>(
  db: DbQueryConnection,
  build: (db: DbQueryConnection) => TQuery,
): TQuery {
  let queries = compiledQueries.get(db);
  if (!queries) {
    queries = new Map();
    compiledQueries.set(db, queries);
  }
  if (queries.has(build)) return queries.get(build) as TQuery;
  const query = build(db);
  queries.set(build, query);
  return query;
}

const queryVariantBuilders = new Map<
  string,
  (db: DbQueryConnection) => unknown
>();

export function prepareCachedQueryVariant<TQuery>(
  db: DbQueryConnection,
  key: string,
  build: (db: DbQueryConnection) => TQuery,
): TQuery {
  let builder = queryVariantBuilders.get(key);
  if (builder === undefined) {
    builder = build;
    queryVariantBuilders.set(key, builder);
  }
  return prepareCachedQuery(db, builder) as TQuery;
}

const rootConnections = new WeakMap<DbQueryConnection, DbConnection>();

export function rootConnectionOf(
  db: DbQueryConnection,
): DbConnection | undefined {
  return rootConnections.get(db);
}

interface TransactionWorkState {
  firstStatementSource: string | null;
  firstWriteSource: string | null;
  mode: TransactionMode;
}

type TransactionMode = "default" | "deferred" | "immediate" | "exclusive";

type StackBoundary = (...args: never[]) => unknown;

interface TimedStatementOperationArgs<TValue> {
  bindingArgumentCount: number;
  callerStackBoundary: StackBoundary | null;
  config: SlowDbQueryConfig;
  operation: SlowDbQueryOperation;
  source: string;
  trackFirstWrite: boolean;
  unknownReader: boolean;
  work: () => TValue;
}

const DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS = 100;
export const SQLITE_CACHE_SIZE_KIB = 262_144;
export const SQLITE_MMAP_SIZE_BYTES = 1_073_741_824;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MAX_LOGGED_SQL_LENGTH = 1_000;
const MAX_WORK_LABEL_SQL_LENGTH = 120;
const SYNCHRONOUS_WORK_STATEMENT_FLOOR_MS = 1;
const MAX_LOGGED_CALLER_FRAMES = 8;
const SQL_TRUNCATION_SUFFIX = "...";
const SQL_STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/gu;
const SQL_WHITESPACE_PATTERN = /\s+/gu;

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function formatSqlForLog(
  source: string,
  maxLength = MAX_LOGGED_SQL_LENGTH,
): string {
  const redacted = source.replace(SQL_STRING_LITERAL_PATTERN, "'?'");
  const normalized = redacted.replace(SQL_WHITESPACE_PATTERN, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(
    0,
    maxLength - SQL_TRUNCATION_SUFFIX.length,
  )}${SQL_TRUNCATION_SUFFIX}`;
}

function describeTransactionWork(state: TransactionWorkState): string {
  const source = state.firstWriteSource ?? state.firstStatementSource;
  const label = `db:transaction ${state.mode}`;
  return source === null
    ? label
    : `${label}: ${formatSqlForLog(source, MAX_WORK_LABEL_SQL_LENGTH)}`;
}

function transactionWorkLabel(state: TransactionWorkState): () => string {
  return () => describeTransactionWork(state);
}

function statementWorkLabel(
  operation: SlowDbQueryOperation,
  source: string,
): () => string {
  return () =>
    `db:${operation} ${formatSqlForLog(source, MAX_WORK_LABEL_SQL_LENGTH)}`;
}

function noteTransactionStatement(
  config: SlowDbQueryConfig,
  source: string,
  writes: boolean,
): void {
  const transaction = config.activeTransaction;
  if (transaction === null) return;
  transaction.firstStatementSource ??= source;
  if (writes) transaction.firstWriteSource ??= source;
}

function captureCallers(boundary: StackBoundary): string[] {
  const trace: { stack?: string } = {};
  Error.captureStackTrace(trace, boundary);
  return (trace.stack ?? "")
    .split("\n")
    .slice(1, MAX_LOGGED_CALLER_FRAMES + 1)
    .map((frame) => frame.trim().replace(/^at /u, ""));
}

function runTimedStatementOperation<TValue>(
  args: TimedStatementOperationArgs<TValue>,
): TValue {
  const startedUsage = args.config.diagnosticsEnabled()
    ? resourceUsage()
    : null;
  const startedCpu = threadCpuUsage();
  const startedAt = performance.now();
  const firstWriteStartedAt =
    (args.trackFirstWrite || args.unknownReader) &&
    args.config.transactionDepth > 0 &&
    args.config.transactionLockWaitSource === null
      ? hrtime.bigint()
      : null;
  try {
    return args.work();
  } finally {
    if (
      firstWriteStartedAt !== null &&
      args.config.transactionLockWaitSource === null
    ) {
      args.config.transactionLockWaitMs =
        Number(hrtime.bigint() - firstWriteStartedAt) / 1_000_000;
      args.config.transactionLockWaitSource = args.trackFirstWrite
        ? "first-write"
        : "unknown";
    }
    const durationMs = performance.now() - startedAt;
    const thresholdMs =
      typeof args.config.thresholdMs === "function"
        ? args.config.thresholdMs()
        : args.config.thresholdMs;
    const tracker = args.config.tracker;
    if (
      tracker !== null &&
      args.operation !== "transaction" &&
      durationMs >= SYNCHRONOUS_WORK_STATEMENT_FLOOR_MS
    ) {
      const cpu = threadCpuUsage(startedCpu);
      tracker.record(
        statementWorkLabel(args.operation, args.source),
        durationMs,
        (cpu.user + cpu.system) / 1_000,
      );
    }
    const logger = args.config.logger;
    if (logger !== null && durationMs >= thresholdMs) {
      const cpu = threadCpuUsage(startedCpu);
      const finishedUsage = startedUsage ? resourceUsage() : null;
      const callers =
        args.callerStackBoundary === null
          ? undefined
          : captureCallers(args.callerStackBoundary);
      const eventLoopWork = args.config.workLabel();
      logger.info(
        {
          bindingArgumentCount: args.bindingArgumentCount,
          durationMs: roundDurationMs(durationMs),
          cpuDurationMs: roundDurationMs((cpu.user + cpu.system) / 1_000),
          ...(args.operation === "transaction"
            ? args.config.transactionDepth === 1 &&
              args.config.transactionLockWaitSource === "exec"
              ? { lockWaitSource: "exec" }
              : {
                  lockWaitMs: roundDurationMs(
                    args.config.transactionDepth === 1
                      ? args.config.transactionLockWaitMs
                      : 0,
                  ),
                  lockWaitSource:
                    args.config.transactionDepth === 1
                      ? (args.config.transactionLockWaitSource ?? "none")
                      : "none",
                  bodyMs: roundDurationMs(
                    Math.max(
                      0,
                      durationMs -
                        (args.config.transactionDepth === 1
                          ? args.config.transactionLockWaitMs
                          : 0),
                    ),
                  ),
                }
            : {}),
          eventLoopWork:
            eventLoopWork ??
            (args.operation === "transaction"
              ? `db transaction: ${callers?.[0] ?? "unknown caller"}`
              : null),
          operation: args.operation,
          sql: formatSqlForLog(args.source),
          thresholdMs,
          ...(callers === undefined ? {} : { callers }),
          ...(startedUsage && finishedUsage
            ? {
                diagnostics: finishQueryDiagnostics(
                  startedUsage,
                  finishedUsage,
                  args.config.sampleWal(),
                ),
              }
            : {}),
        },
        "Slow DB query",
      );
    }
  }
}

function instrumentStatement(
  statement: Database.Statement,
  source: string,
  config: SlowDbQueryConfig,
): Database.Statement {
  const readerLockWaitSource = classifyStatementReader(statement);
  const originalAll = statement.all.bind(statement);
  const originalGet = statement.get.bind(statement);
  const originalRun = statement.run.bind(statement);
  const writes = !statement.readonly;

  statement.all = (...params) => {
    noteTransactionStatement(config, source, writes);
    config.queryPlanObserver()?.observeFirstExecution(source, params);
    return runTimedStatementOperation({
      bindingArgumentCount: params.length,
      callerStackBoundary: null,
      config,
      operation: "all",
      source,
      trackFirstWrite: readerLockWaitSource === "first-write",
      unknownReader: readerLockWaitSource === "unknown",
      work: () => originalAll(...params),
    });
  };
  statement.get = (...params) => {
    noteTransactionStatement(config, source, writes);
    config.queryPlanObserver()?.observeFirstExecution(source, params);
    return runTimedStatementOperation({
      bindingArgumentCount: params.length,
      callerStackBoundary: null,
      config,
      operation: "get",
      source,
      trackFirstWrite: readerLockWaitSource === "first-write",
      unknownReader: readerLockWaitSource === "unknown",
      work: () => originalGet(...params),
    });
  };
  statement.run = (...params) => {
    noteTransactionStatement(config, source, writes);
    config.queryPlanObserver()?.observeFirstExecution(source, params);
    return runTimedStatementOperation({
      bindingArgumentCount: params.length,
      callerStackBoundary: null,
      config,
      operation: "run",
      source,
      trackFirstWrite: readerLockWaitSource === "first-write",
      unknownReader: readerLockWaitSource === "unknown",
      work: () => originalRun(...params),
    });
  };

  return statement;
}

function instrumentSqliteClient(
  sqlite: Database.Database,
  options: CreateConnectionOptions,
): void {
  if (
    !options.slowQueryLogger &&
    !options.synchronousWorkTracker &&
    !options.queryPlanObserver
  ) {
    return;
  }

  const config: SlowDbQueryConfig = {
    activeTransaction: null,
    logger: options.slowQueryLogger ?? null,
    tracker: options.synchronousWorkTracker ?? null,
    thresholdMs:
      options.slowQueryThresholdMs ?? DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS,
    workLabel: options.slowQueryWorkLabel ?? (() => null),
    walPath: sqlite.memory ? null : `${resolve(sqlite.name)}-wal`,
    sampleWal: createWalSampler(
      sqlite.memory ? null : `${resolve(sqlite.name)}-wal`,
    ),
    diagnosticsEnabled: options.slowQueryDiagnosticsEnabled ?? (() => false),
    queryPlanObserver: options.queryPlanObserver ?? (() => null),
    transactionDepth: 0,
    transactionLockWaitMs: 0,
    transactionLockWaitSource: null,
    transactionStartNs: null,
  };
  const originalExec = sqlite.exec.bind(sqlite);
  sqlite.exec = (source) => {
    if (
      config.transactionDepth > 0 &&
      config.transactionLockWaitSource === null
    ) {
      config.transactionLockWaitSource = "exec";
    }
    return runTimedStatementOperation({
      bindingArgumentCount: 0,
      callerStackBoundary: null,
      config,
      operation: "exec",
      source,
      trackFirstWrite: false,
      unknownReader: false,
      work: () => originalExec(source),
    });
  };
  const originalTransaction = sqlite.transaction.bind(sqlite);
  sqlite.transaction = (fn) => {
    const wrappedFn = function (
      this: ThisParameterType<typeof fn>,
      ...params: Parameters<typeof fn>
    ): ReturnType<typeof fn> {
      if (
        config.transactionDepth === 1 &&
        config.transactionStartNs !== null
      ) {
        config.transactionLockWaitMs =
          Number(hrtime.bigint() - config.transactionStartNs) / 1_000_000;
        config.transactionStartNs = null;
      }
      return fn.apply(this, params) as ReturnType<typeof fn>;
    } as typeof fn;
    const original = originalTransaction(wrappedFn);
    function wrap(mode: "default" | "deferred" | "immediate" | "exclusive") {
      return function timedTransaction(
        this: unknown,
        ...params: Parameters<typeof original>
      ) {
        const outermost = config.transactionDepth === 0;
        if (outermost) {
          config.transactionLockWaitMs = 0;
          config.transactionLockWaitSource =
            mode === "immediate" || mode === "exclusive" ? "begin" : null;
        }
        const tracker = config.tracker;
        const outerTransaction = config.activeTransaction;
        const state: TransactionWorkState = {
          firstStatementSource: null,
          firstWriteSource: null,
          mode,
        };
        config.activeTransaction = state;
        config.transactionDepth++;
        try {
          return runTimedStatementOperation({
            bindingArgumentCount: params.length,
            callerStackBoundary: timedTransaction,
            config,
            operation: "transaction",
            source: `TRANSACTION ${mode.toUpperCase()}`,
            trackFirstWrite: false,
            unknownReader: false,
            work: () => {
              if (outermost && config.transactionLockWaitSource === "begin") {
                config.transactionStartNs = hrtime.bigint();
              }
              try {
                return tracker === null
                  ? original[mode].apply(this, params)
                  : tracker.run(transactionWorkLabel(state), () =>
                      original[mode].apply(this, params),
                    );
              } finally {
                if (outermost && config.transactionStartNs !== null) {
                  config.transactionLockWaitMs =
                    Number(hrtime.bigint() - config.transactionStartNs) /
                    1_000_000;
                  config.transactionStartNs = null;
                }
              }
            },
          });
        } finally {
          config.transactionDepth--;
          config.activeTransaction = outerTransaction;
        }
      };
    }
    const modes = {
      default: wrap("default"),
      deferred: wrap("deferred"),
      immediate: wrap("immediate"),
      exclusive: wrap("exclusive"),
    };
    const transaction = Object.assign(modes.default, modes);
    for (const mode of Object.values(modes)) {
      Object.defineProperties(mode, {
        default: {
          value: modes.default,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        deferred: {
          value: modes.deferred,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        immediate: {
          value: modes.immediate,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        exclusive: {
          value: modes.exclusive,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        database: { value: sqlite, enumerable: true },
      });
    }
    return transaction;
  };
  const originalPrepare: Database.Database["prepare"] =
    sqlite.prepare.bind(sqlite);

  function prepare(source: string): Database.Statement {
    return instrumentStatement(originalPrepare(source), source, config);
  }

  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value: prepare,
    writable: true,
  });
}

export function createConnection(
  source: string | Buffer = "bb.db",
  options: CreateConnectionOptions = {},
) {
  const sqlite = new Database(source);

  sqlite.pragma("auto_vacuum = INCREMENTAL");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KIB}`);
  sqlite.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  registerHostPathSqlFunctions(sqlite);
  instrumentSqliteClient(sqlite, options);

  const db = drizzle({ client: sqlite, schema });
  const queries = new Map<(db: DbQueryConnection) => unknown, unknown>();
  compiledQueries.set(db, queries);
  rootConnections.set(db, db);
  const originalTransaction = db.transaction.bind(db);
  const commitContext: CommitContext = { pending: undefined };
  commitContexts.set(db, commitContext);
  function prepareTransaction(tx: DbTransaction): void {
    compiledQueries.set(tx, queries);
    rootConnections.set(tx, db);
    commitContexts.set(tx, commitContext);
    const nestedTransaction = tx.transaction.bind(tx);
    tx.transaction = (work) =>
      transactionCallbacks(() =>
        nestedTransaction((nested) => {
          prepareTransaction(nested);
          return work(nested);
        }),
      );
  }
  function transactionCallbacks<T>(work: () => T): T {
    const parent = commitContext.pending;
    const callbacks: Array<() => void> = [];
    let result: T;
    try {
      commitContext.pending = callbacks;
      result = work();
    } finally {
      commitContext.pending = parent;
    }
    if (parent) parent.push(...callbacks);
    else
      for (const callback of callbacks) {
        try {
          callback();
        } catch {}
      }
    return result;
  }
  db.transaction = (work, config) =>
    transactionCallbacks(() =>
      originalTransaction((tx) => {
        prepareTransaction(tx);
        return work(tx);
      }, config),
    );
  const originalClose = sqlite.close.bind(sqlite);
  sqlite.close = () => {
    const result = originalClose();
    queries.clear();
    return result;
  };

  if (options.databaseWriteBytesLogger !== undefined) {
    databaseWriteBytesLoggers.set(db, options.databaseWriteBytesLogger);
    databaseWriteBytesLoggers.set(sqlite, options.databaseWriteBytesLogger);
  }

  return db;
}

export function logDatabaseWriteBytes(
  db: DbQueryConnection | Database.Database,
  fields: DatabaseWriteBytesLogFields,
): void {
  let logger = databaseWriteBytesLoggers.get(db);
  if (logger === undefined && "$client" in db) {
    logger = databaseWriteBytesLoggers.get(db.$client);
  }
  if (logger === undefined && "session" in db) {
    const session = db.session;
    if (
      typeof session === "object" &&
      session !== null &&
      "client" in session
    ) {
      const client = session.client;
      if (typeof client === "object" && client !== null) {
        logger = databaseWriteBytesLoggers.get(client);
      }
    }
  }
  logger?.debug(fields, "Database write payload bytes by source");
}
