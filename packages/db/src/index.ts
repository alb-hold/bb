export { createConnection } from "./connection.js";
export type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
  SlowDbQueryLogger,
  SlowDbQueryLogFields,
} from "./connection.js";

export * from "./schema.js";
export {
  createQueuedThreadMessageId,
  createEventId,
  createHostId,
  createThreadProvisioningId,
} from "./ids.js";

export { countAppliedMigrations, migrate } from "./migrate.js";
export {
  getThreadSpawner,
  recordThreadSpawner,
} from "./fork-thread-spawners.js";
export {
  clearTerminalAttention,
  ensureTerminalAttentionTable,
  getTerminalAttention,
  upsertTerminalAttention,
  type TerminalAttentionKind,
  type TerminalAttentionRecord,
} from "./fork-terminal-attention.js";
export {
  consumeNativeTerminalThreadLaunchInput,
  createNativeTerminalThread,
  deleteNativeTerminalThread,
  findNativeTerminalThreadBySession,
  getNativeTerminalThread,
  isNativeTerminalThread,
  listNativeTerminalThreadIds,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  recordNativeTerminalThreadSessionId,
  setNativeTerminalThreadTerminal,
  type NativeTerminalThreadRecord,
  type RecordNativeSessionIdResult,
  setNativeTerminalToolCredential,
  getNativeTerminalToolCredential,
  deleteNativeTerminalToolCredential,
  type NativeTerminalToolCredentialRecord,
} from "./fork-native-terminal-threads.js";
export {
  isSqliteForeignKeyConstraint,
  isSqliteUniqueConstraintOnColumns,
} from "./sqlite-errors.js";
export type { MigrationWarningLogger } from "./migrate.js";
export { deriveStoredEventItemFields } from "./stored-event-item-fields.js";
export { noopNotifier } from "./notifier.js";
export type { DbNotifier } from "./notifier.js";

export * from "./data/index.js";
