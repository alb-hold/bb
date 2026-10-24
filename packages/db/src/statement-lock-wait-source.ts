export type StatementLockWaitSource = "first-write" | "unknown" | "none";

export function classifyStatementReader(statement: {
  reader: unknown;
}): StatementLockWaitSource {
  if (statement.reader === false) return "first-write";
  if (statement.reader === true) return "none";
  return "unknown";
}
