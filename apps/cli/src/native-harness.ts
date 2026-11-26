import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fillNativeTerminalTemplate,
  type ProviderNativeTerminal,
} from "@bb/domain";
import {
  expandSessionFiles,
  resolveNativeTerminalSessionRoot,
  resolveNativeTerminalTranscriptPattern,
} from "./native-session-files.js";
export { expandSessionFiles } from "./native-session-files.js";
import { experimental_nativeTerminalEnvArgs } from "@get-bb/plugin-sdk/host";
import type { NativeTerminalLaunchSpec } from "@bb/server-contract";
import { readRecordField } from "./native-activity.js";

const SESSION_HEADER_MAX_BYTES = 4 * 1024 * 1024;
const SESSION_CLOCK_SKEW_MS = 5_000;
const DAY_MS = 86_400_000;

export type NativeHarnessSession =
  | { kind: "start"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "discover" };

export interface NativeHarnessLaunch {
  command: string;
  args: string[];
  session: NativeHarnessSession;
}

export type NativeHarnessEnv = Readonly<Record<string, string | undefined>>;

type DiscoveredSession = Extract<
  ProviderNativeTerminal["session"],
  { kind: "discovered" }
>;
type SqliteDiscoveredSession = Extract<
  ProviderNativeTerminal["session"],
  { kind: "sqlite-discovered" }
>;

let cachedDatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null;

function loadSqliteDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
  if (cachedDatabaseSync !== null) return cachedDatabaseSync;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : undefined;
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
    return Reflect.apply(originalEmitWarning, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    const sqlite = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    cachedDatabaseSync = sqlite.DatabaseSync;
    return cachedDatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export function nativeSessionRoot(
  cli: ProviderNativeTerminal,
  env: NativeHarnessEnv,
): string {
  return resolveNativeTerminalSessionRoot(cli.sessionRoot, env);
}

function fill(
  values: readonly string[],
  tokens: Readonly<Record<string, string>>,
): string[] {
  return values.map((value) => fillNativeTerminalTemplate(value, tokens));
}

export interface NativeMcpCommand {
  args: readonly string[];
  command: string;
}

export function nativeMcpArgs(
  cli: ProviderNativeTerminal,
  server: NativeMcpCommand,
): string[] {
  if (cli.mcp === undefined) return [];
  return fill(cli.mcp, {
    commandJson: JSON.stringify(server.command),
    argsJson: JSON.stringify(server.args),
  });
}

export function resolveNativeHarnessLaunch(
  spec: NativeTerminalLaunchSpec,
  env: NativeHarnessEnv,
  activityArgs: readonly string[] = [],
  mcpArgs: readonly string[] = [],
  cwd: string = process.cwd(),
): NativeHarnessLaunch {
  const { cli } = spec;
  const workspace =
    cli.workspaceArgs === undefined
      ? []
      : fill(cli.workspaceArgs, { cwd, cwdJson: JSON.stringify(cwd) });
  const model = [
    ...cli.launchArgs,
    ...workspace,
    ...experimental_nativeTerminalEnvArgs(
      cli.experimental_launchEnvArgs,
      env,
      cwd,
    ),
    ...(spec.model === null ? [] : fill(cli.modelArgs, { model: spec.model })),
    ...activityArgs,
    ...mcpArgs,
  ];
  const initialPromptArgs =
    spec.initialPrompt === null
      ? []
      : cli.promptArgs !== undefined && cli.promptArgs.length > 0
        ? fill(cli.promptArgs, { prompt: spec.initialPrompt })
        : [spec.initialPrompt];
  const prompt = [
    ...initialPromptArgs,
    ...(spec.initialImages ?? []).flatMap((image) =>
      fill(cli.imageArgs ?? [], { image }),
    ),
  ];
  const session = cli.session;
  if (session.kind === "assigned") {
    if (spec.nativeSessionId === null) {
      throw new Error(
        `${cli.executable} native threads need a preassigned session id`,
      );
    }
    const tokens = { sessionId: spec.nativeSessionId };
    const transcriptExists =
      expandSessionFiles(
        nativeSessionRoot(cli, env),
        fillNativeTerminalTemplate(session.transcript, tokens),
      ).length > 0;
    return {
      command: cli.executable,
      args: transcriptExists
        ? [...model, ...fill(session.resumeArgs, tokens)]
        : [...model, ...fill(session.startArgs, tokens), ...prompt],
      session: {
        kind: transcriptExists ? "resume" : "start",
        id: spec.nativeSessionId,
      },
    };
  }
  if (spec.nativeSessionId !== null) {
    return {
      command: cli.executable,
      args: [
        ...model,
        ...fill(session.resumeArgs, { sessionId: spec.nativeSessionId }),
      ],
      session: { kind: "resume", id: spec.nativeSessionId },
    };
  }
  return {
    command: cli.executable,
    args: [...model, ...prompt],
    session: { kind: "discover" },
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function candidateDayTokens(
  times: readonly number[],
): Array<Record<string, string>> {
  const seen = new Map<string, Record<string, string>>();
  for (const time of times) {
    for (const offsetDays of [-1, 0]) {
      const day = new Date(time + offsetDays * DAY_MS);
      const tokens = {
        yyyy: String(day.getFullYear()),
        mm: pad(day.getMonth() + 1),
        dd: pad(day.getDate()),
      };
      seen.set(`${tokens.yyyy}-${tokens.mm}-${tokens.dd}`, tokens);
    }
  }
  return [...seen.values()];
}

function readFirstLine(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < SESSION_HEADER_MAX_BYTES) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) return null;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(chunk));
      total += read;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

interface SessionHeader {
  id: string;
  cwd: string;
  startedAtMs: number;
}

function parseSessionHeader(
  line: string,
  header: DiscoveredSession["header"],
  options: { forDiscovery: boolean } = { forDiscovery: false },
): SessionHeader | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  for (const [field, expected] of Object.entries(header.match)) {
    if (readRecordField(json, field) !== expected) return null;
  }
  if (options.forDiscovery) {
    for (const [field, expected] of Object.entries(
      header.discoveryMatch ?? {},
    )) {
      if (readRecordField(json, field) !== expected) return null;
    }
  }
  const id = readRecordField(json, header.id);
  const cwd = readRecordField(json, header.cwd);
  const startedAt = readRecordField(json, header.startedAt);
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  if (typeof startedAt !== "string") return null;
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return null;
  return { id, cwd, startedAtMs };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function findNativeSessionFile(
  cli: ProviderNativeTerminal,
  env: NativeHarnessEnv,
  sessionId: string,
): string | null {
  const root = nativeSessionRoot(cli, env);
  const session = cli.session;
  if (session.kind === "assigned" || session.kind === "sqlite-discovered") {
    const resolved = resolveNativeTerminalTranscriptPattern({
      sessionRoot: cli.sessionRoot,
      transcriptPattern: session.transcript,
      sessionId,
      env,
    });
    return expandSessionFiles(resolved.root, resolved.pattern)[0] ?? null;
  }
  const files = expandSessionFiles(
    root,
    fillNativeTerminalTemplate(session.transcripts, {
      yyyy: "*",
      mm: "*",
      dd: "*",
    }),
  ).sort(
    (left, right) =>
      Number(path.basename(right).includes(sessionId)) -
      Number(path.basename(left).includes(sessionId)),
  );
  for (const filePath of files) {
    const line = readFirstLine(filePath);
    if (line === null) continue;
    if (parseSessionHeader(line, session.header)?.id === sessionId) {
      return filePath;
    }
  }
  return null;
}

export type NativeSessionMatch =
  | { kind: "none" }
  | { kind: "unique"; sessionId: string }
  | { kind: "ambiguous"; sessionIds: string[] };

function workspacePathsFromUris(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const paths: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (entry.startsWith("file://")) {
      try {
        paths.push(fileURLToPath(entry));
      } catch {
        continue;
      }
    } else {
      paths.push(entry);
    }
  }
  return paths;
}

function minimumTimestampForPrecision(raw: string, boundaryMs: number): number {
  return /\.\d+/u.test(raw)
    ? boundaryMs
    : Math.floor(boundaryMs / 1_000) * 1_000;
}

function readTranscriptStartedAt(
  filePath: string,
  fieldPath: string,
): { raw: string; startedAtMs: number } | null {
  const line = readFirstLine(filePath);
  if (line === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const startedAt = readRecordField(parsed, fieldPath);
  if (typeof startedAt !== "string") return null;
  const startedAtMs = Date.parse(startedAt);
  return Number.isNaN(startedAtMs) ? null : { raw: startedAt, startedAtMs };
}

export function snapshotNativeWorkspaceSessions(args: {
  cli: ProviderNativeTerminal;
  cwd: string;
  env: NativeHarnessEnv;
}): ReadonlySet<string> | null {
  const session = args.cli.session;
  if (session.kind !== "sqlite-discovered") return new Set<string>();
  const dbPath = path.join(
    nativeSessionRoot(args.cli, args.env),
    session.database,
  );
  try {
    if (!statSync(dbPath).isFile()) return new Set<string>();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set<string>();
    }
    return null;
  }
  const ids = new Set<string>();
  let db: InstanceType<ReturnType<typeof loadSqliteDatabaseSync>> | null = null;
  try {
    const DatabaseSync = loadSqliteDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT "${session.idColumn}" AS id, "${session.workspaceUrisColumn}" AS workspace_uris FROM "${session.table}"`,
      )
      .all() as Array<{ id?: unknown; workspace_uris?: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (typeof row.workspace_uris !== "string") continue;
      if (
        workspacePathsFromUris(row.workspace_uris).some((wsPath) =>
          samePath(wsPath, args.cwd),
        )
      ) {
        ids.add(row.id);
      }
    }
    return ids;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function findSqliteNativeSession(
  args: {
    cli: ProviderNativeTerminal;
    cwd: string;
    env: NativeHarnessEnv;
    excludeSessionIds?: ReadonlySet<string> | null;
    launchedAtMs: number;
  },
  session: SqliteDiscoveredSession,
): NativeSessionMatch {
  if (args.excludeSessionIds === null) return { kind: "none" };
  const dbPath = path.join(
    nativeSessionRoot(args.cli, args.env),
    session.database,
  );
  try {
    if (!statSync(dbPath).isFile()) return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
  const ids = new Set<string>();
  let db: InstanceType<ReturnType<typeof loadSqliteDatabaseSync>> | null = null;
  try {
    const DatabaseSync = loadSqliteDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT "${session.idColumn}" AS id, "${session.workspaceUrisColumn}" AS workspace_uris, "${session.startedAtColumn}" AS started_at FROM "${session.table}"`,
      )
      .all() as Array<{
      id?: unknown;
      workspace_uris?: unknown;
      started_at?: unknown;
    }>;
    for (const row of rows) {
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (args.excludeSessionIds?.has(row.id) === true) continue;
      if (typeof row.started_at !== "string") continue;
      const startedAtMs = Date.parse(row.started_at);
      if (
        Number.isNaN(startedAtMs) ||
        startedAtMs <
          minimumTimestampForPrecision(row.started_at, args.launchedAtMs)
      ) {
        continue;
      }
      if (typeof row.workspace_uris !== "string") continue;
      if (
        !workspacePathsFromUris(row.workspace_uris).some((wsPath) =>
          samePath(wsPath, args.cwd),
        )
      ) {
        continue;
      }
      const transcriptFile = findNativeSessionFile(args.cli, args.env, row.id);
      if (transcriptFile === null) continue;
      const createdAt = readTranscriptStartedAt(
        transcriptFile,
        session.transcriptStartedAtField,
      );
      if (
        createdAt === null ||
        createdAt.startedAtMs <
          minimumTimestampForPrecision(createdAt.raw, args.launchedAtMs)
      ) {
        continue;
      }
      ids.add(row.id);
    }
  } catch {
    return { kind: "none" };
  } finally {
    try {
      db?.close();
    } catch {}
  }
  if (ids.size === 0) return { kind: "none" };
  if (ids.size === 1) return { kind: "unique", sessionId: [...ids][0]! };
  return { kind: "ambiguous", sessionIds: [...ids].sort() };
}

export function findNativeSession(args: {
  cli: ProviderNativeTerminal;
  cwd: string;
  env: NativeHarnessEnv;
  excludeSessionIds?: ReadonlySet<string> | null;
  launchedAtMs: number;
  nowMs: number;
}): NativeSessionMatch {
  const session = args.cli.session;
  if (session.kind === "sqlite-discovered") {
    return findSqliteNativeSession(args, session);
  }
  if (session.kind !== "discovered") return { kind: "none" };
  const root = nativeSessionRoot(args.cli, args.env);
  const sinceMs = args.launchedAtMs - SESSION_CLOCK_SKEW_MS;
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const tokens of candidateDayTokens([args.launchedAtMs, args.nowMs])) {
    for (const file of expandSessionFiles(
      root,
      fillNativeTerminalTemplate(session.transcripts, tokens),
    )) {
      files.add(file);
    }
  }
  for (const filePath of files) {
    let modifiedMs: number;
    try {
      modifiedMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedMs < sinceMs) continue;
    const line = readFirstLine(filePath);
    const header =
      line === null
        ? null
        : parseSessionHeader(line, session.header, { forDiscovery: true });
    if (header === null) continue;
    if (header.startedAtMs < sinceMs) continue;
    if (!samePath(header.cwd, args.cwd)) continue;
    ids.add(header.id);
  }
  if (ids.size === 0) return { kind: "none" };
  if (ids.size === 1) return { kind: "unique", sessionId: [...ids][0]! };
  return { kind: "ambiguous", sessionIds: [...ids].sort() };
}
