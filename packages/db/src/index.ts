export { afterCommit, createConnection } from "./connection.js";
export type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
  SlowDbQueryLogger,
  SlowDbQueryLogFields,
  ThreadListClientKind,
  ThreadListRequestShape,
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
  clearThreadRowState,
  getThreadRowProgressOutputSeqs,
  getThreadRowProgressSourceTerminalId,
  getThreadRowState,
  listThreadRowStatesByScope,
  putThreadRowState,
  raiseThreadRowProgressOutputSeqs,
  type ThreadRowProgress,
  type ThreadRowState,
  type ThreadRowStatus,
} from "./fork-thread-row-state.js";
export {
  clearThreadRowStateAtOutputSeqs,
  listThreadTerminalLatestOutputSeqs,
} from "./fork-thread-terminal-output-seqs.js";
export type { ThreadListEnrichmentScope } from "./thread-list-enrichment-scope.js";
export {
  clearTerminalAttention,
  clearPersistedDeviceHandoffAttention,
  deleteDeviceHandoffAttentionMarker,
  ensureTerminalAttentionTable,
  getDeviceHandoffAttentionMarker,
  getTerminalAttention,
  listDeviceHandoffAttentionMarkers,
  listTerminalAttention,
  setDeviceHandoffAttentionMarker,
  upsertTerminalAttention,
  type DeviceHandoffAttentionMarker,
  type TerminalAttentionKind,
  type TerminalAttentionRecord,
} from "./fork-terminal-attention.js";
export {
  appendRetainedTerminalOutputChunk,
  appendRetainedTerminalOutputChunks,
  dismissRetainedTerminalOutput,
  getRetainedTerminalOutput,
  markRetainedTerminalOutputExited,
  pruneRetainedTerminalOutput,
  TERMINAL_RETAINED_OUTPUT_BYTES,
  HOST_RETAINED_OUTPUT_BYTES,
  HOST_RETAINED_TERMINAL_LIMIT,
  TERMINAL_OUTPUT_RETENTION_MS,
  type RetainedTerminalOutputChunk,
  type RetainedTerminalOutputAppendTimings,
} from "./fork-terminal-output.js";
export {
  consumeNativeTerminalThreadLaunchInput,
  createNativeTerminalThread,
  deleteNativeTerminalThread,
  findNativeTerminalThreadBySession,
  getNativeTerminalThread,
  isNativeTerminalThread,
  listNativeTerminalThreadIds,
  listNativeTerminalThreadsByIds,
  listNativeTerminalThreadsNeedingStatusCheck,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  recordNativeTerminalThreadSessionId,
  clearNativeTerminalThreadActivityEvidence,
  clearNativeTerminalThreadEvidence,
  rebindNativeTerminalThreadSessionId,
  stampNativeTerminalThreadActivity,
  stampNativeTerminalTranscriptEvidence,
  stampNativeTerminalThreadToolCall,
  setNativeTerminalThreadTerminal,
  type NativeTerminalThreadRecord,
  type RecordNativeSessionIdResult,
  type StampNativeTerminalActivityResult,
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
