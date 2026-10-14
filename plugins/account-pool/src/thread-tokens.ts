import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { providerSchema } from "./contracts.js";
import type { HubTokenStore } from "./store.js";

const THREAD_ROUTE_PREFIX = "scoped-route-";
const LEGACY_THREAD_ROUTE_PREFIX = "thread-route-";
const PROCESS_THREAD_ROUTE_PREFIX = "scoped-process-route-";
const NESTED_ROUTE_PREFIX = "scoped-nested-route-";
const PROCESS_NESTED_ROUTE_PREFIX = "scoped-process-nested-route-";
export const PROCESS_CREDENTIAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DURABLE_PRIOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PROCESS_CREDENTIAL_CLOCK_SKEW_MS = 60 * 1000;
export const ARCHIVE_TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MARKER_ANCHOR_TOLERANCE_MS = 1_000;
const LEGACY_NESTED_ROUTE_PREFIX = "nested-route-";
const ARCHIVED_THREAD_PREFIX = "archived-thread-";
const ARCHIVE_FALLBACK_PREFIX = "archive-revocation-";
const REVOKED_ROUTE_PREFIX = "revoked-route-";
const TOMBSTONE_PREFIX = "archived-credentials-";
const CREDENTIAL_PREFIXES = [
  THREAD_ROUTE_PREFIX,
  PROCESS_THREAD_ROUTE_PREFIX,
  LEGACY_THREAD_ROUTE_PREFIX,
  NESTED_ROUTE_PREFIX,
  PROCESS_NESTED_ROUTE_PREFIX,
  LEGACY_NESTED_ROUTE_PREFIX,
];
const MARKER_TEMPORARY =
  /^(archived-thread-|archive-revocation-)([a-f0-9]{64})\.json\.[A-Za-z0-9-]+\.tmp$/u;

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const archiveStateSchema = z
  .object({
    threadId: identifierSchema,
    epoch: z.number().int().nonnegative(),
    archived: z.boolean(),
  })
  .strict();

const legacyRouteSchema = z
  .object({
    hostId: identifierSchema,
    threadId: identifierSchema,
    provider: providerSchema,
    accountId: z.string().uuid().nullable(),
    token: tokenSchema,
    hostTokenDigest: digestSchema,
  })
  .strict();

const legacyNestedRouteSchema = z
  .object({
    hostId: identifierSchema,
    threadId: identifierSchema,
    token: tokenSchema,
    hostTokenDigest: digestSchema,
  })
  .strict();

export const MAX_PRIOR_CREDENTIALS = 3;
const priorCredentialSchema = z
  .object({
    tokenDigest: digestSchema,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    usedAt: z.number().int().positive().optional(),
  })
  .strict();
const routeSchema = legacyRouteSchema.omit({ token: true }).extend({
  token: tokenSchema.optional(),
  tokenDigest: digestSchema,
  lifetime: z.literal("process").optional(),
  expiresAt: z.number().int().positive().optional(),
  issuedAt: z.number().int().positive().optional(),
  usedAt: z.number().int().positive().optional(),
  priors: z.array(priorCredentialSchema).max(MAX_PRIOR_CREDENTIALS).optional(),
});
const nestedRouteSchema = legacyNestedRouteSchema.omit({ token: true }).extend({
  token: tokenSchema.optional(),
  tokenDigest: digestSchema,
  lifetime: z.literal("process").optional(),
  expiresAt: z.number().int().positive().optional(),
  issuedAt: z.number().int().positive().optional(),
  usedAt: z.number().int().positive().optional(),
  priors: z.array(priorCredentialSchema).max(MAX_PRIOR_CREDENTIALS).optional(),
});
const readableRouteSchema = z.union([
  routeSchema,
  legacyRouteSchema.transform((record) => ({
    ...record,
    tokenDigest: digest(record.token),
  })),
]);
const readableNestedRouteSchema = z.union([
  nestedRouteSchema,
  legacyNestedRouteSchema.transform((record) => ({
    ...record,
    tokenDigest: digest(record.token),
  })),
]);

const tombstoneSchema = z
  .object({
    threadId: identifierSchema,
    epoch: z.number().int().positive(),
    archivedAt: z.number().int().positive(),
    routes: z.array(routeSchema.omit({ token: true })),
    nested: z.array(nestedRouteSchema.omit({ token: true })),
  })
  .strict();

class CredentialScrubError extends Error {}

type RouteRecord = z.infer<typeof routeSchema>;
type NestedRouteRecord = z.infer<typeof nestedRouteSchema>;
type PriorCredential = z.infer<typeof priorCredentialSchema>;

export type ThreadRoute = Omit<
  RouteRecord,
  "token" | "tokenDigest" | "hostTokenDigest" | "lifetime" | "usedAt" | "priors"
>;
export type NestedRoute = Omit<
  NestedRouteRecord,
  "token" | "tokenDigest" | "hostTokenDigest" | "lifetime" | "usedAt" | "priors"
>;

type Tombstone = {
  threadId: string;
  epoch: number;
  archivedAt: number;
  routes: RouteRecord[];
  nested: NestedRouteRecord[];
  durable: boolean;
  holdsAnchor?: boolean;
};

type Window = { start: number | null; open: boolean; unlowered: string[] };

type PendingFile =
  | { threadId: string; record: RouteRecord; nested: false }
  | { threadId: string; record: NestedRouteRecord; nested: true };

export type ThreadLookupResult =
  | "live"
  | "archived"
  | "gone"
  | { status: "archived"; archivedAt: number };
export type ThreadLookup = (
  threadId: string,
  signal?: AbortSignal,
) => Promise<ThreadLookupResult>;
export type ThreadSweepOptions = {
  signal?: AbortSignal;
  lookupTimeoutMs?: number;
};
export type ThreadSweepResult = {
  checked: number;
  revoked: number;
  failed: number;
};

export class ThreadTokenStore {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly tokenIndex = new Map<string, RouteRecord>();
  private readonly nestedRoutes = new Map<string, NestedRouteRecord>();
  private readonly nestedTokenIndex = new Map<string, NestedRouteRecord>();
  private readonly archivedThreads = new Set<string>();
  private readonly activeArchiveMarkers = new Set<string>();
  private readonly archiveEpochs = new Map<string, number>();
  private readonly seenArchiveMarkers = new Set<string>();
  private readonly transientArchiveReadFailures = new Set<string>();
  private readonly corruptArchiveMarkers = new Set<string>();
  private readonly archiveDurabilityFailures = new Set<string>();
  private archiveMarkersLoaded = false;
  private readonly lookupFailures = new Map<string, number>();
  private readonly archiveVersions = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private readonly pendingPriorDrops = new WeakSet<object>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly expiredTombstoneThreads = new Set<string>();
  private pendingFiles: PendingFile[] = [];
  private readonly unverified = new Set<string>();
  private readonly archivedMarkerFiles = new Set<string>();
  private readonly leftoverTemporaries = new Map<string, string[]>();

  constructor(
    private readonly directory: string,
    private readonly hosts: HubTokenStore,
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  async initialize(
    hostIds: readonly string[],
    lookup: ThreadLookup,
    options: ThreadSweepOptions = {},
  ): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const enrolled = new Set(hostIds);
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (
        (name.startsWith(ARCHIVED_THREAD_PREFIX) ||
          name.startsWith(ARCHIVE_FALLBACK_PREFIX)) &&
        name.endsWith(".json")
      )
        await this.loadArchiveMarker(name);
    }
    await this.settleTemporaries(names);
    this.archiveMarkersLoaded = true;
    for (const name of names) {
      await this.loadFile(name, enrolled).catch((error) => {
        if (error instanceof CredentialScrubError) throw error;
      });
    }
    const answers = await this.archiveAnswers(
      [
        ...this.pendingFiles.map((entry) => entry.threadId),
        ...this.tombstones.keys(),
      ],
      lookup,
      options,
    );
    await this.recoverPendingFiles(answers.archivedAt);
    for (const [threadId, archivedAt] of answers.archivedAt)
      await this.clampTombstone(threadId, archivedAt);
    for (const threadId of answers.gone) await this.deleteThread(threadId);
    for (const record of this.routes.values())
      this.unverified.add(record.threadId);
    for (const record of this.nestedRoutes.values())
      this.unverified.add(record.threadId);
    await this.checkThreads([...this.unverified], lookup, options);
  }

  private async settleTemporaries(names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (
        name.endsWith(".tmp") &&
        (name.startsWith(TOMBSTONE_PREFIX) ||
          CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix)))
      ) {
        await this.dropFile(path.join(this.directory, name));
        continue;
      }
      const match = MARKER_TEMPORARY.exec(name);
      if (match === null) continue;
      const marker = `${match[1]}${match[2]}.json`;
      const partner = `${match[1] === ARCHIVED_THREAD_PREFIX ? ARCHIVE_FALLBACK_PREFIX : ARCHIVED_THREAD_PREFIX}${match[2]}.json`;
      const file = path.join(this.directory, name);
      let text: string | null = null;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        text = null;
      }
      const state = text === null ? null : readArchiveState(text);
      if (
        text !== null &&
        state !== null &&
        digest(state.threadId) === match[2]
      ) {
        if (!state.archived) {
          await this.dropFile(file);
          continue;
        }
        this.applyArchiveState(marker, text);
        if (
          this.archivedThreads.has(state.threadId) &&
          this.archiveEpoch(state.threadId) === state.epoch
        ) {
          try {
            const unanchored = new Date(0);
            await fs.utimes(file, unanchored, unanchored);
            await fs.rename(file, path.join(this.directory, marker));
            this.seenArchiveMarkers.add(marker);
          } catch {
            this.keepTemporary(marker, name);
          }
        } else await this.dropFile(file);
        continue;
      }
      if (
        this.archivedMarkerFiles.has(marker) ||
        this.archivedMarkerFiles.has(partner)
      ) {
        await this.dropFile(file);
        continue;
      }
      this.corruptArchiveMarkers.add(marker);
      this.keepTemporary(marker, name);
    }
  }

  private keepTemporary(marker: string, name: string): void {
    this.leftoverTemporaries.set(marker, [
      ...(this.leftoverTemporaries.get(marker) ?? []),
      name,
    ]);
  }

  private async removeMarkerTemporaries(threadId: string): Promise<void> {
    for (const marker of this.archiveMarkerNames(threadId)) {
      const leftovers = this.leftoverTemporaries.get(marker);
      if (leftovers === undefined) continue;
      this.leftoverTemporaries.delete(marker);
      for (const name of leftovers)
        await this.dropFile(path.join(this.directory, name));
    }
  }

  private async loadArchiveMarker(name: string): Promise<void> {
    this.seenArchiveMarkers.add(name);
    let text: string;
    try {
      text = await fs.readFile(path.join(this.directory, name), "utf8");
    } catch {
      this.transientArchiveReadFailures.add(name);
      return;
    }
    this.applyArchiveState(name, text);
  }

  private async loadFile(
    name: string,
    enrolled: ReadonlySet<string>,
  ): Promise<void> {
    if (!name.endsWith(".json")) return;
    const file = path.join(this.directory, name);
    if (name.startsWith(REVOKED_ROUTE_PREFIX)) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      return;
    }
    if (name.startsWith(ARCHIVED_THREAD_PREFIX)) return;
    if (name.startsWith(TOMBSTONE_PREFIX)) {
      await this.loadTombstone(name, enrolled);
      return;
    }
    if (
      name.startsWith(THREAD_ROUTE_PREFIX) ||
      name.startsWith(PROCESS_THREAD_ROUTE_PREFIX) ||
      name.startsWith(LEGACY_THREAD_ROUTE_PREFIX)
    ) {
      const loaded = await this.readCredential(file, readableRouteSchema);
      const record =
        loaded === null
          ? null
          : {
              ...this.withLivePriors(
                loaded,
                name.startsWith(PROCESS_THREAD_ROUTE_PREFIX),
              ),
              lifetime: name.startsWith(PROCESS_THREAD_ROUTE_PREFIX)
                ? ("process" as const)
                : undefined,
            };
      const archived =
        record === null ? false : await this.isArchived(record.threadId);
      if (
        record !== null &&
        archived &&
        this.hasTransientArchiveReadFailure(record.threadId)
      )
        return;
      if (
        record !== null &&
        !archived &&
        this.restorable(record) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        this.routes.set(this.routeMapKey(record), record);
        indexCredential(this.tokenIndex, record);
      } else if (
        record !== null &&
        archived &&
        this.awaitsTombstone(name, record)
      )
        this.pendingFiles.push({
          threadId: record.threadId,
          record,
          nested: false,
        });
      else await fs.rm(file, { force: true });
    } else if (
      name.startsWith(NESTED_ROUTE_PREFIX) ||
      name.startsWith(PROCESS_NESTED_ROUTE_PREFIX) ||
      name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
    ) {
      const loaded = await this.readCredential(file, readableNestedRouteSchema);
      const record =
        loaded === null
          ? null
          : {
              ...this.withLivePriors(
                loaded,
                name.startsWith(PROCESS_NESTED_ROUTE_PREFIX),
              ),
              lifetime: name.startsWith(PROCESS_NESTED_ROUTE_PREFIX)
                ? ("process" as const)
                : undefined,
            };
      const archived =
        record === null ? false : await this.isArchived(record.threadId);
      if (
        record !== null &&
        archived &&
        this.hasTransientArchiveReadFailure(record.threadId)
      )
        return;
      if (
        record !== null &&
        !archived &&
        this.restorable(record) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        this.nestedRoutes.set(this.nestedMapKey(record), record);
        indexCredential(this.nestedTokenIndex, record);
      } else if (
        record !== null &&
        archived &&
        this.awaitsTombstone(name, record)
      )
        this.pendingFiles.push({
          threadId: record.threadId,
          record,
          nested: true,
        });
      else await fs.rm(file, { force: true });
    }
  }

  async forThread(
    route: ThreadRoute,
    hostToken: string,
    lifetime: "durable" | "process" = "durable",
  ): Promise<string> {
    const parsed = routeSchema
      .omit({
        token: true,
        tokenDigest: true,
        hostTokenDigest: true,
        usedAt: true,
        priors: true,
      })
      .parse(route);
    const hostTokenDigest = digest(hostToken);
    return this.serialize(async () => {
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      const key = this.routeMapKey({
        ...parsed,
        hostTokenDigest,
        ...(lifetime === "process" ? { lifetime } : {}),
      });
      const existing = this.routes.get(key);
      if (existing?.token !== undefined && !this.expired(existing))
        return existing.token;
      const priors = this.retainedPriors(existing);
      const token = randomBytes(32).toString("base64url");
      const record = {
        ...parsed,
        hostTokenDigest,
        token,
        tokenDigest: digest(token),
        ...(lifetime === "process"
          ? { lifetime, ...this.processLifetime() }
          : {}),
        ...(priors.length === 0 ? {} : { priors }),
      };
      await this.persistCredential(this.file(record), record);
      if (existing !== undefined) unindexCredential(this.tokenIndex, existing);
      this.routes.set(key, record);
      indexCredential(this.tokenIndex, record);
      await this.reclaimDead(record);
      return record.token;
    });
  }

  async forNested(
    route: NestedRoute,
    hostToken: string,
    lifetime: "durable" | "process" = "durable",
  ): Promise<string> {
    const parsed = nestedRouteSchema
      .omit({
        token: true,
        tokenDigest: true,
        hostTokenDigest: true,
        usedAt: true,
        priors: true,
      })
      .parse(route);
    const hostTokenDigest = digest(hostToken);
    return this.serialize(async () => {
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      const key = this.nestedMapKey({
        ...parsed,
        hostTokenDigest,
        ...(lifetime === "process" ? { lifetime } : {}),
      });
      const existing = this.nestedRoutes.get(key);
      if (existing?.token !== undefined && !this.expired(existing))
        return existing.token;
      const priors = this.retainedPriors(existing);
      const token = randomBytes(32).toString("base64url");
      const record = {
        ...parsed,
        hostTokenDigest,
        token,
        tokenDigest: digest(token),
        ...(lifetime === "process"
          ? { lifetime, ...this.processLifetime() }
          : {}),
        ...(priors.length === 0 ? {} : { priors }),
      };
      await this.persistCredential(this.nestedFile(record), record);
      if (existing !== undefined)
        unindexCredential(this.nestedTokenIndex, existing);
      this.nestedRoutes.set(key, record);
      indexCredential(this.nestedTokenIndex, record);
      await this.reclaimDead(record);
      return record.token;
    });
  }

  async authenticate(
    token: string | null,
    provider?: ThreadRoute["provider"],
  ): Promise<ThreadRoute | null> {
    const match = lookup(this.tokenIndex, token);
    if (match === null || this.credentialExpired(match)) return null;
    const { record } = match;
    if (await this.isArchived(record.threadId)) return null;
    if (this.unverified.has(record.threadId)) return null;
    if (provider !== undefined && provider !== record.provider) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    await this.noteUse({ nested: false, record }, match.prior);
    return {
      hostId: record.hostId,
      threadId: record.threadId,
      provider: record.provider,
      accountId: record.accountId,
    };
  }

  isProcessCredential(token: string | null): boolean {
    const match = lookup(this.tokenIndex, token);
    return (
      match !== null &&
      !this.credentialExpired(match) &&
      this.routes.get(
        `process:${this.key(match.record, match.record.hostTokenDigest)}`,
      ) === match.record
    );
  }

  async authenticateNested(token: string | null): Promise<NestedRoute | null> {
    const match = lookup(this.nestedTokenIndex, token);
    if (match === null || this.credentialExpired(match)) return null;
    const { record } = match;
    if (await this.isArchived(record.threadId)) return null;
    if (this.unverified.has(record.threadId)) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    await this.noteUse({ nested: true, record }, match.prior);
    return { hostId: record.hostId, threadId: record.threadId };
  }

  async removeThread(threadId: string): Promise<void> {
    await this.revokeThread(threadId, true);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.revokeThread(threadId, false);
  }

  private async revokeThread(
    threadId: string,
    restorable: boolean,
    archivedAt?: number,
  ): Promise<void> {
    this.archiveVersions.set(threadId, this.archiveVersion(threadId) + 1);
    this.unverified.delete(threadId);
    const advanceEpoch = !this.archivedThreads.has(threadId);
    const epochUnknown = advanceEpoch && this.hasMarkerFailure(threadId);
    this.archivedThreads.add(threadId);
    this.activeArchiveMarkers.delete(threadId);
    await this.serialize(async () => {
      const epoch = this.archiveEpoch(threadId);
      let nextEpoch = advanceEpoch ? epoch + 1 : epoch;
      if (epochUnknown) nextEpoch = (await this.maxFileEpoch(threadId)) + 2;
      this.archiveEpochs.set(threadId, nextEpoch);
      if (!restorable || epochUnknown) await this.dropTombstone(threadId, true);
      let names: string[] = [];
      let directoryReadFailed = false;
      try {
        names = await fs.readdir(this.directory);
      } catch {
        directoryReadFailed = true;
      }
      if (epochUnknown) await this.purgeCredentialFiles(threadId, names);
      const shouldPersist =
        directoryReadFailed ||
        this.archiveMarkerNames(threadId).some((name) =>
          this.seenArchiveMarkers.has(name),
        ) ||
        [...this.routes.values()].some(
          (record) => record.threadId === threadId,
        ) ||
        [...this.nestedRoutes.values()].some(
          (record) => record.threadId === threadId,
        ) ||
        this.hasCredentialFile(threadId, names);
      let markerError: unknown;
      const anchor = Math.min(this.now(), archivedAt ?? this.now());
      const markerCurrent =
        !advanceEpoch &&
        !this.archiveDurabilityFailures.has(threadId) &&
        !this.hasMarkerFailure(threadId) &&
        this.archiveMarkerNames(threadId).some((name) =>
          this.seenArchiveMarkers.has(name),
        );
      if (shouldPersist && !markerCurrent) {
        try {
          await this.persist(
            this.archivedFile(threadId),
            { threadId, epoch: nextEpoch, archived: true },
            anchor,
          );
          this.seenArchiveMarkers.add(this.archivedName(threadId));
          this.clearMarkerFailures(threadId);
          this.archiveDurabilityFailures.delete(threadId);
          await this.removeMarkerTemporaries(threadId);
        } catch (error) {
          try {
            await this.persist(
              this.archiveFallbackFile(threadId),
              { threadId, epoch: nextEpoch, archived: true },
              anchor,
            );
            this.seenArchiveMarkers.add(this.archiveFallbackName(threadId));
            this.clearMarkerFailures(threadId);
            this.archiveDurabilityFailures.delete(threadId);
            await this.removeMarkerTemporaries(threadId);
          } catch {
            markerError = error;
            this.archiveDurabilityFailures.add(threadId);
          }
        }
      }
      if (restorable && !epochUnknown && markerError === undefined)
        await this.tombstoneCredentials(threadId, nextEpoch, archivedAt);
      const tombstone = this.tombstones.get(threadId);
      const keepFiles =
        tombstone !== undefined &&
        !tombstone.durable &&
        markerError === undefined;
      if (keepFiles)
        this.warn(
          `Account Pooler could not persist the archive tombstone for thread ${threadId}; its credentials stay rejected and are retried on the next archive event or sweep.`,
        );
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        this.routes.delete(key);
        unindexCredential(this.tokenIndex, record);
        if (keepFiles) continue;
        await this.removeProviderFiles(
          record,
          Math.max(0, nextEpoch - 1),
        ).catch(() => undefined);
      }
      for (const [key, record] of this.nestedRoutes) {
        if (record.threadId !== threadId) continue;
        this.nestedRoutes.delete(key);
        unindexCredential(this.nestedTokenIndex, record);
        if (keepFiles) continue;
        await this.removeNestedFiles(record, Math.max(0, nextEpoch - 1)).catch(
          () => undefined,
        );
      }
      await this.quarantineUnreadableLegacyFiles(threadId, names).catch(
        () => undefined,
      );
      if (markerError !== undefined) throw markerError;
    });
  }

  async sweepThreads(
    lookup: ThreadLookup,
    options: ThreadSweepOptions = {},
  ): Promise<ThreadSweepResult> {
    await this.serialize(async () => {
      await this.purgeExpiredTombstones();
      await this.retryTombstones();
    });
    const threadIds = new Set<string>(this.tombstones.keys());
    for (const record of this.routes.values()) threadIds.add(record.threadId);
    for (const record of this.nestedRoutes.values())
      threadIds.add(record.threadId);
    for (const threadId of this.lookupFailures.keys())
      if (!threadIds.has(threadId)) this.lookupFailures.delete(threadId);
    const ordered = [...threadIds].sort(
      (left, right) =>
        (this.lookupFailures.get(left) ?? 0) -
        (this.lookupFailures.get(right) ?? 0),
    );
    return this.checkThreads(ordered, lookup, options);
  }

  private async checkThreads(
    ordered: readonly string[],
    lookup: ThreadLookup,
    options: ThreadSweepOptions,
  ): Promise<ThreadSweepResult> {
    const result: ThreadSweepResult = {
      checked: ordered.length,
      revoked: 0,
      failed: 0,
    };
    for (const threadId of ordered) {
      if (options.signal?.aborted === true) {
        result.failed += 1;
        continue;
      }
      const lookupSignal = this.lookupSignal(options);
      const version = this.archiveVersion(threadId);
      try {
        const found = await untilAborted(
          lookup(threadId, lookupSignal),
          lookupSignal,
        );
        const status = typeof found === "string" ? found : found.status;
        const archivedAt =
          typeof found === "string" ? undefined : found.archivedAt;
        this.lookupFailures.delete(threadId);
        if (status === "live") {
          this.unverified.delete(threadId);
          if (this.tombstones.has(threadId))
            await this.restoreThread(threadId, version);
          continue;
        }
        if (status === "archived" && archivedAt !== undefined)
          await this.serialize(() => this.clampTombstone(threadId, archivedAt));
        if (status === "archived" && !this.hasRoutes(threadId)) {
          this.unverified.delete(threadId);
          continue;
        }
        if (
          await this.removeThreadIfVersion(
            threadId,
            version,
            status === "gone",
            archivedAt,
          )
        )
          result.revoked += 1;
      } catch {
        this.lookupFailures.set(
          threadId,
          (this.lookupFailures.get(threadId) ?? 0) + 1,
        );
        result.failed += 1;
      }
    }
    return result;
  }

  async removeThreadIfVersion(
    threadId: string,
    expectedVersion: number,
    final = false,
    archivedAt?: number,
  ): Promise<boolean> {
    if (this.archiveVersion(threadId) !== expectedVersion)
      return this.archivedThreads.has(threadId);
    if (final) await this.deleteThread(threadId);
    else await this.revokeThread(threadId, true, archivedAt);
    return true;
  }

  private hasRoutes(threadId: string): boolean {
    return (
      [...this.routes.values()].some(
        (record) => record.threadId === threadId,
      ) ||
      [...this.nestedRoutes.values()].some(
        (record) => record.threadId === threadId,
      )
    );
  }

  archiveVersion(threadId: string): number {
    return this.archiveVersions.get(threadId) ?? 0;
  }

  async restoreThread(
    threadId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.serialize(async () => {
      if (this.archiveVersion(threadId) !== expectedVersion) return;
      this.unverified.delete(threadId);
      if (this.activeArchiveMarkers.has(threadId)) return;
      if (
        this.archiveEpoch(threadId) === 0 &&
        !this.archivedThreads.has(threadId) &&
        !this.hasMarkerFailure(threadId) &&
        !this.archiveDurabilityFailures.has(threadId)
      )
        return;
      const epoch = (await this.maxFileEpoch(threadId)) + 1;
      const revived = await this.reviveTombstone(threadId, epoch);
      await this.persist(this.archivedFile(threadId), {
        threadId,
        epoch,
        archived: false,
      });
      if (this.seenArchiveMarkers.has(this.archiveFallbackName(threadId))) {
        await this.persist(this.archiveFallbackFile(threadId), {
          threadId,
          epoch,
          archived: false,
        });
      }
      this.archivedThreads.delete(threadId);
      this.activeArchiveMarkers.add(threadId);
      this.archiveEpochs.set(threadId, epoch);
      this.seenArchiveMarkers.add(this.archivedName(threadId));
      if (this.seenArchiveMarkers.has(this.archiveFallbackName(threadId)))
        this.seenArchiveMarkers.add(this.archiveFallbackName(threadId));
      this.clearMarkerFailures(threadId);
      this.archiveDurabilityFailures.delete(threadId);
      await this.removeMarkerTemporaries(threadId);
      for (const record of revived.routes) {
        this.routes.set(this.routeMapKey(record), record);
        indexCredential(this.tokenIndex, record);
      }
      for (const record of revived.nested) {
        this.nestedRoutes.set(this.nestedMapKey(record), record);
        indexCredential(this.nestedTokenIndex, record);
      }
      await this.dropTombstone(threadId);
    });
  }

  private tombstoneName(threadId: string): string {
    return `${TOMBSTONE_PREFIX}${digest(threadId)}.json`;
  }

  private tombstoneFile(threadId: string): string {
    return path.join(this.directory, this.tombstoneName(threadId));
  }

  private async archiveMarkerAnchors(threadId: string): Promise<{
    anchors: Array<{ file: string; modifiedAt: number }>;
    unreadable: boolean;
  }> {
    const anchors: Array<{ file: string; modifiedAt: number }> = [];
    let unreadable = false;
    for (const name of this.archiveMarkerNames(threadId)) {
      const file = path.join(this.directory, name);
      try {
        const state = readArchiveState(await fs.readFile(file, "utf8"));
        if (
          state === null ||
          !state.archived ||
          state.threadId !== threadId ||
          state.epoch !== this.archiveEpoch(threadId)
        )
          continue;
        anchors.push({
          file,
          modifiedAt: Math.round((await fs.stat(file)).mtimeMs),
        });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") unreadable = true;
      }
    }
    return { anchors, unreadable };
  }

  private async lowerMarker(file: string, modifiedAt: number): Promise<void> {
    const stamp = new Date(modifiedAt);
    const handle = await fs.open(file, "r+");
    try {
      await handle.utimes(stamp, stamp);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async restoreWindow(
    threadId: string,
    known: { tombstoneAt?: number; bbAt?: number } = {},
  ): Promise<Window> {
    const { anchors: markers, unreadable } =
      await this.archiveMarkerAnchors(threadId);
    const anchors = [
      known.tombstoneAt,
      known.bbAt,
      ...markers.map((marker) => marker.modifiedAt),
    ].filter((anchor): anchor is number => anchor !== undefined);
    if (anchors.length === 0)
      return { start: null, open: false, unlowered: [] };
    const start = Math.min(...anchors);
    const unlowered: string[] = [];
    for (const marker of markers)
      if (marker.modifiedAt - start > MARKER_ANCHOR_TOLERANCE_MS)
        try {
          await this.lowerMarker(marker.file, start);
        } catch {
          unlowered.push(marker.file);
        }
    const postdated =
      known.tombstoneAt !== undefined &&
      known.tombstoneAt > this.now() + PROCESS_CREDENTIAL_CLOCK_SKEW_MS;
    const open =
      !postdated &&
      !unreadable &&
      !this.tombstoneExpired({ archivedAt: start });
    return { start, open, unlowered };
  }

  private async settleWindow(
    tombstone: Tombstone,
    window: Window,
  ): Promise<boolean> {
    if (window.start === null) return false;
    const shrank = window.start < tombstone.archivedAt;
    if (shrank) tombstone.archivedAt = window.start;
    if (window.unlowered.length === 0) {
      tombstone.holdsAnchor = false;
      if (shrank && window.open && tombstone.durable)
        await this.persistTombstone(tombstone);
      return window.open;
    }
    if (shrank || !tombstone.durable) await this.persistTombstone(tombstone);
    tombstone.holdsAnchor = tombstone.durable;
    if (!tombstone.durable) await this.voidMarkers(window.unlowered);
    return tombstone.durable && window.open;
  }

  private async voidMarkers(files: readonly string[]): Promise<void> {
    for (const file of files)
      await fs
        .rename(file, `${file}.${randomUUID()}.tmp`)
        .catch(() => undefined);
  }

  private async windowOpen(
    tombstone: Tombstone,
    bbAt?: number,
  ): Promise<boolean> {
    return this.settleWindow(
      tombstone,
      await this.restoreWindow(tombstone.threadId, {
        tombstoneAt: tombstone.archivedAt,
        bbAt,
      }),
    );
  }

  private tombstoneExpired(tombstone: { archivedAt: number }): boolean {
    const now = this.now();
    return (
      tombstone.archivedAt > now + PROCESS_CREDENTIAL_CLOCK_SKEW_MS ||
      tombstone.archivedAt + ARCHIVE_TOMBSTONE_MAX_AGE_MS <= now
    );
  }

  private async tombstoneCredentials(
    threadId: string,
    epoch: number,
    archivedAt?: number,
  ): Promise<void> {
    const held = this.tombstones.get(threadId);
    const heldOpen =
      held === undefined ? true : await this.windowOpen(held, archivedAt);
    if (held !== undefined && !heldOpen) {
      await this.dropTombstone(threadId, true);
      if (held.epoch === epoch) return;
    } else if (held?.epoch === epoch) {
      if (!held.durable) {
        await this.persistTombstone(held);
        if (held.durable) await this.removePendingFiles(held);
      }
      return;
    }
    const routes = [...this.routes.values()].filter(
      (record) => record.threadId === threadId,
    );
    const nested = [...this.nestedRoutes.values()].filter(
      (record) => record.threadId === threadId,
    );
    await this.dropTombstone(threadId);
    if (routes.length === 0 && nested.length === 0) return;
    const tombstone = {
      threadId,
      epoch,
      archivedAt: Math.min(this.now(), archivedAt ?? this.now()),
      routes,
      nested,
      durable: false,
    };
    const open = await this.windowOpen(tombstone, archivedAt);
    if (!open && !tombstone.durable) return;
    this.tombstones.set(threadId, tombstone);
    if (!open) {
      await this.dropTombstone(threadId, true);
      return;
    }
    await this.persistTombstone(tombstone);
  }

  private expireUnreadablePending(threadId: string): void {
    void this.serialize(async () => {
      if (!this.archivedThreads.has(threadId)) return;
      const epoch = this.archiveEpoch(threadId);
      await this.dropTombstone(threadId, true);
      let names: string[];
      try {
        names = await fs.readdir(this.directory);
      } catch {
        return;
      }
      await this.purgeCredentialFiles(threadId, names, epoch - 1);
    });
  }

  private async purgeCredentialFiles(
    threadId: string,
    names: readonly string[],
    epoch?: number,
  ): Promise<void> {
    for (const name of names) {
      if (epoch !== undefined && this.fileEpoch(name) !== epoch) continue;
      const nested =
        name.startsWith(NESTED_ROUTE_PREFIX) ||
        name.startsWith(PROCESS_NESTED_ROUTE_PREFIX) ||
        name.startsWith(LEGACY_NESTED_ROUTE_PREFIX);
      const route =
        name.startsWith(THREAD_ROUTE_PREFIX) ||
        name.startsWith(PROCESS_THREAD_ROUTE_PREFIX) ||
        name.startsWith(LEGACY_THREAD_ROUTE_PREFIX);
      if (!nested && !route) continue;
      const file = path.join(this.directory, name);
      try {
        const record = await readRecord(
          file,
          nested ? readableNestedRouteSchema : readableRouteSchema,
        );
        if (record?.threadId === threadId)
          await this.removeCredentialFile(file);
      } catch {
        continue;
      }
    }
  }

  private async persistTombstone(tombstone: Tombstone): Promise<void> {
    const { durable, holdsAnchor, ...stored } = tombstone;
    tombstone.durable = false;
    try {
      await this.persist(this.tombstoneFile(tombstone.threadId), {
        ...stored,
        routes: tombstone.routes.map(({ token, ...record }) => record),
        nested: tombstone.nested.map(({ token, ...record }) => record),
      });
    } catch {
      return;
    }
    tombstone.durable = true;
  }

  private async retryTombstones(): Promise<void> {
    for (const tombstone of this.tombstones.values()) {
      if (
        tombstone.durable ||
        !this.archivedThreads.has(tombstone.threadId) ||
        tombstone.epoch !== this.archiveEpoch(tombstone.threadId)
      )
        continue;
      if (!(await this.windowOpen(tombstone))) {
        await this.dropTombstone(tombstone.threadId, true);
        continue;
      }
      await this.persistTombstone(tombstone);
      if (tombstone.durable) await this.removePendingFiles(tombstone);
      else
        this.warn(
          `Account Pooler still could not persist the archive tombstone for thread ${tombstone.threadId}.`,
        );
    }
  }

  private async removePendingFiles(
    tombstone: Pick<Tombstone, "epoch" | "routes" | "nested">,
  ): Promise<void> {
    const epoch = Math.max(0, tombstone.epoch - 1);
    for (const record of tombstone.routes)
      await this.removeProviderFiles(record, epoch).catch(() => undefined);
    for (const record of tombstone.nested)
      await this.removeNestedFiles(record, epoch).catch(() => undefined);
  }

  private async dropTombstone(threadId: string, force = false): Promise<void> {
    const tombstone = this.tombstones.get(threadId);
    this.tombstones.delete(threadId);
    const removePending =
      tombstone !== undefined && (force || !tombstone.durable);
    if (removePending && tombstone.holdsAnchor === true)
      await this.removePendingFiles(tombstone);
    if (tombstone !== undefined || force)
      await this.removeCredentialFile(this.tombstoneFile(threadId)).catch(
        () => undefined,
      );
    if (removePending && tombstone.holdsAnchor !== true)
      await this.removePendingFiles(tombstone);
  }

  private awaitsTombstone(name: string, record: { threadId: string }): boolean {
    const epoch = this.archiveEpoch(record.threadId);
    return epoch > 0 && this.fileEpoch(name) === epoch - 1;
  }

  private lookupSignal(options: ThreadSweepOptions): AbortSignal | undefined {
    const signals = [
      ...(options.signal === undefined ? [] : [options.signal]),
      ...(options.lookupTimeoutMs === undefined
        ? []
        : [AbortSignal.timeout(options.lookupTimeoutMs)]),
    ];
    return signals.length === 0 ? undefined : AbortSignal.any(signals);
  }

  private async archiveAnswers(
    threadIds: Iterable<string>,
    lookup: ThreadLookup,
    options: ThreadSweepOptions,
  ): Promise<{ archivedAt: Map<string, number>; gone: Set<string> }> {
    const answers = {
      archivedAt: new Map<string, number>(),
      gone: new Set<string>(),
    };
    for (const threadId of new Set(threadIds)) {
      if (options.signal?.aborted === true) break;
      const signal = this.lookupSignal(options);
      try {
        const found = await untilAborted(lookup(threadId, signal), signal);
        if (found === "gone") answers.gone.add(threadId);
        else if (typeof found !== "string")
          answers.archivedAt.set(threadId, found.archivedAt);
      } catch {
        continue;
      }
    }
    return answers;
  }

  private async clampTombstone(
    threadId: string,
    archivedAt: number,
  ): Promise<void> {
    const held = this.tombstones.get(threadId);
    if (held === undefined) return;
    if (!(await this.windowOpen(held, archivedAt)))
      await this.dropTombstone(threadId, true);
  }

  private async recoverPendingFiles(
    archiveTimes: ReadonlyMap<string, number>,
  ): Promise<void> {
    const pending = this.pendingFiles;
    this.pendingFiles = [];
    for (const threadId of new Set(pending.map((entry) => entry.threadId))) {
      const entries = pending.filter((entry) => entry.threadId === threadId);
      const epoch = this.archiveEpoch(threadId);
      const routes = entries.flatMap((entry) =>
        entry.nested ? [] : [entry.record],
      );
      const nested = entries.flatMap((entry) =>
        entry.nested ? [entry.record] : [],
      );
      const held = this.tombstones.get(threadId);
      const window = await this.restoreWindow(threadId, {
        tombstoneAt: held?.archivedAt,
        bbAt: archiveTimes.get(threadId),
      });
      const tombstone: Tombstone = {
        threadId,
        epoch,
        archivedAt: window.start ?? 0,
        routes,
        nested,
        durable: false,
      };
      if (held?.epoch === epoch || this.expiredTombstoneThreads.has(threadId)) {
        await this.removePendingFiles(tombstone);
        continue;
      }
      const open = await this.settleWindow(tombstone, window);
      if (!open) {
        this.tombstones.set(threadId, tombstone);
        await this.dropTombstone(threadId, true);
        continue;
      }
      this.tombstones.set(threadId, tombstone);
      await this.persistTombstone(tombstone);
      if (tombstone.durable) await this.removePendingFiles(tombstone);
      else
        this.warn(
          `Account Pooler could not persist the archive tombstone for thread ${threadId}; it is retried on the next sweep.`,
        );
    }
  }

  private async purgeExpiredTombstones(): Promise<void> {
    for (const [threadId, tombstone] of this.tombstones)
      if (!(await this.windowOpen(tombstone)))
        await this.dropTombstone(threadId, true);
  }

  private async reviveTombstone(
    threadId: string,
    epoch: number,
  ): Promise<{ routes: RouteRecord[]; nested: NestedRouteRecord[] }> {
    const revived = {
      routes: [] as RouteRecord[],
      nested: [] as NestedRouteRecord[],
    };
    const tombstone = this.tombstones.get(threadId);
    if (tombstone === undefined) return revived;
    if (tombstone.epoch !== this.archiveEpoch(threadId)) {
      await this.dropTombstone(threadId);
      return revived;
    }
    if (!(await this.windowOpen(tombstone))) {
      await this.dropTombstone(threadId, true);
      return revived;
    }
    for (const stored of tombstone.routes) {
      const record = this.withLivePriors(stored, stored.lifetime === "process");
      if (
        !this.restorable(record) ||
        this.routes.has(this.routeMapKey(record)) ||
        !(await this.isGenerationLive(record))
      )
        continue;
      await this.persistCredential(this.fileAtEpoch(record, epoch), record);
      revived.routes.push(record);
    }
    for (const stored of tombstone.nested) {
      const record = this.withLivePriors(stored, stored.lifetime === "process");
      if (
        !this.restorable(record) ||
        this.nestedRoutes.has(this.nestedMapKey(record)) ||
        !(await this.isGenerationLive(record))
      )
        continue;
      await this.persistCredential(
        this.nestedFileAtEpoch(record, epoch),
        record,
      );
      revived.nested.push(record);
    }
    return revived;
  }

  private async loadTombstone(
    name: string,
    enrolled: ReadonlySet<string>,
  ): Promise<void> {
    const file = path.join(this.directory, name);
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) await this.dropFile(file);
      return;
    }
    const parsed = tombstoneSchema.safeParse(value);
    if (!parsed.success || name !== this.tombstoneName(parsed.data.threadId)) {
      await this.dropFile(file);
      return;
    }
    const { threadId, epoch, archivedAt } = parsed.data;
    if (this.hasTransientArchiveReadFailure(threadId)) {
      await this.dropFile(file);
      await this.removePendingFiles({
        epoch,
        routes: parsed.data.routes,
        nested: parsed.data.nested,
      });
      return;
    }
    const owned = (record: { threadId: string }) =>
      record.threadId === threadId;
    const alive = async (record: {
      hostId: string;
      hostTokenDigest: string;
      lifetime?: "process";
      expiresAt?: number;
      issuedAt?: number;
    }) => this.restorable(record) && (await this.isLive(record, enrolled));
    const routes: RouteRecord[] = [];
    for (const record of parsed.data.routes)
      if (owned(record) && (await alive(record))) routes.push(record);
    const nested: NestedRouteRecord[] = [];
    for (const record of parsed.data.nested)
      if (owned(record) && (await alive(record))) nested.push(record);
    const tombstone = {
      threadId,
      epoch,
      archivedAt,
      routes,
      nested,
      durable: true,
    };
    if (
      !this.archivedThreads.has(threadId) ||
      this.archiveEpoch(threadId) !== epoch ||
      (routes.length === 0 && nested.length === 0)
    ) {
      await this.dropFile(file);
      return;
    }
    if (!(await this.windowOpen(tombstone))) {
      this.expiredTombstoneThreads.add(threadId);
      this.tombstones.set(threadId, tombstone);
      await this.dropTombstone(threadId, true);
      return;
    }
    this.tombstones.set(threadId, tombstone);
  }

  private async dropFile(file: string): Promise<void> {
    await this.removeCredentialFile(file).catch(() => undefined);
  }

  private async reclaimDead(minted: {
    hostId: string;
    threadId: string;
    hostTokenDigest: string;
  }): Promise<void> {
    const stale = (record: {
      hostId: string;
      threadId: string;
      hostTokenDigest: string;
    }) =>
      record.hostId === minted.hostId &&
      record.threadId === minted.threadId &&
      record.hostTokenDigest !== minted.hostTokenDigest;
    for (const [key, record] of this.routes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await this.removeProviderFiles(
        record,
        this.archiveEpoch(record.threadId),
      ).catch(() => undefined);
      this.routes.delete(key);
      unindexCredential(this.tokenIndex, record);
    }
    for (const [key, record] of this.nestedRoutes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await this.removeNestedFiles(
        record,
        this.archiveEpoch(record.threadId),
      ).catch(() => undefined);
      this.nestedRoutes.delete(key);
      unindexCredential(this.nestedTokenIndex, record);
    }
  }

  private isGenerationLive(record: {
    hostId: string;
    hostTokenDigest: string;
  }): Promise<boolean> {
    return this.hosts.isGenerationLive(record.hostId, record.hostTokenDigest);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async isLive(
    record: { hostId: string; hostTokenDigest: string },
    enrolled: ReadonlySet<string>,
  ): Promise<boolean> {
    return enrolled.has(record.hostId) && (await this.isGenerationLive(record));
  }

  private async readCredential<
    T extends { token?: string; tokenDigest: string },
  >(file: string, schema: z.ZodType<T>): Promise<T | null> {
    const record = await readRecord(file, schema);
    if (record?.token !== undefined) {
      try {
        await this.persistCredential(file, record);
      } catch {
        throw new CredentialScrubError(
          "Account Pooler could not remove a persisted scoped credential.",
        );
      }
    }
    return record === null ? null : { ...record, token: undefined };
  }

  private async persistCredential(
    file: string,
    record: { token?: string; tokenDigest: string; lifetime?: "process" },
  ): Promise<void> {
    const { token, lifetime, ...stored } = record;
    await this.persist(file, stored);
  }

  private async persist(
    file: string,
    record: object,
    modifiedAt?: number,
  ): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
        if (modifiedAt !== undefined) {
          const stamp = new Date(modifiedAt);
          await handle.utimes(stamp, stamp);
          await handle.sync();
        }
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const directory = await fs.open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private applyArchiveState(name: string, text: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.corruptArchiveMarkers.add(name);
      return true;
    }
    const parsed = archiveStateSchema.safeParse(value);
    if (
      !parsed.success ||
      !this.archiveMarkerNames(parsed.data.threadId).includes(name)
    ) {
      this.corruptArchiveMarkers.add(name);
      return true;
    }
    this.corruptArchiveMarkers.delete(name);
    this.transientArchiveReadFailures.delete(name);
    if (parsed.data.archived) this.archivedMarkerFiles.add(name);
    else this.archivedMarkerFiles.delete(name);
    const threadId = parsed.data.threadId;
    const currentEpoch = this.archiveEpoch(threadId);
    const currentArchived = this.archivedThreads.has(threadId);
    if (parsed.data.epoch < currentEpoch) return currentArchived;
    if (parsed.data.epoch === currentEpoch && currentArchived) return true;
    this.archiveEpochs.set(threadId, parsed.data.epoch);
    if (parsed.data.archived) {
      this.archivedThreads.add(threadId);
      this.activeArchiveMarkers.delete(threadId);
    } else {
      this.archivedThreads.delete(threadId);
      this.activeArchiveMarkers.add(threadId);
    }
    return parsed.data.archived;
  }

  private hasCredentialFile(
    threadId: string,
    names: readonly string[],
  ): boolean {
    for (const name of names) {
      if (
        !name.startsWith(THREAD_ROUTE_PREFIX) &&
        !name.startsWith(PROCESS_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(NESTED_ROUTE_PREFIX) &&
        !name.startsWith(PROCESS_NESTED_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      )
        continue;
      if (name.includes(threadId)) return true;
    }
    return false;
  }

  private async maxFileEpoch(threadId: string): Promise<number> {
    let epoch = this.archiveEpoch(threadId);
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (
        !name.startsWith(THREAD_ROUTE_PREFIX) &&
        !name.startsWith(PROCESS_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(NESTED_ROUTE_PREFIX) &&
        !name.startsWith(PROCESS_NESTED_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      )
        continue;
      if (name.includes(threadId))
        epoch = Math.max(epoch, this.fileEpoch(name));
    }
    return epoch;
  }

  private async removeNestedFiles(
    route: NestedRoute & { hostTokenDigest: string },
    epoch: number,
  ): Promise<void> {
    await Promise.all([
      this.removeCredentialFile(this.nestedFileAtEpoch(route, epoch)),
      this.removeCredentialFile(this.legacyNestedFile(route)),
    ]);
  }

  private legacyNestedFile(
    route: NestedRoute & { hostTokenDigest: string },
  ): string {
    return path.join(
      this.directory,
      `${LEGACY_NESTED_ROUTE_PREFIX}${this.nestedKey(route, route.hostTokenDigest)}.json`,
    );
  }

  private key(route: ThreadRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.provider}-${route.threadId}-${route.accountId ?? "automatic"}-${hostTokenDigest}`;
  }

  private file(route: ThreadRoute & { hostTokenDigest: string }): string {
    return this.fileAtEpoch(route, this.archiveEpoch(route.threadId));
  }

  private fileAtEpoch(
    route: ThreadRoute & { hostTokenDigest: string; lifetime?: "process" },
    epoch: number,
  ): string {
    const prefix =
      route.lifetime === "process"
        ? PROCESS_THREAD_ROUTE_PREFIX
        : THREAD_ROUTE_PREFIX;
    return path.join(
      this.directory,
      `${prefix}${this.key(route, route.hostTokenDigest)}-v${epoch}.json`,
    );
  }

  private withLivePriors<
    T extends { tokenDigest: string; priors?: PriorCredential[] },
  >(record: T, process: boolean): T {
    if (record.priors === undefined) return record;
    const live = process
      ? record.priors
          .filter((prior) => this.restorable({ lifetime: "process", ...prior }))
          .slice(-MAX_PRIOR_CREDENTIALS)
      : record.priors
          .filter((prior) => prior.expiresAt > this.now())
          .slice(-MAX_PRIOR_CREDENTIALS);
    return { ...record, priors: live.length === 0 ? undefined : live };
  }

  private retainedPriors(
    existing: RouteRecord | NestedRouteRecord | undefined,
  ): PriorCredential[] {
    if (existing !== undefined && existing.lifetime !== "process")
      return this.retainedDurablePriors(existing);
    if (
      existing === undefined ||
      existing.token !== undefined ||
      this.expired(existing) ||
      existing.issuedAt === undefined ||
      existing.expiresAt === undefined
    )
      return [];
    const kept = (existing.priors ?? []).filter(
      (prior) => !this.expired({ lifetime: "process", ...prior }),
    );
    kept.push({
      tokenDigest: existing.tokenDigest,
      issuedAt: existing.issuedAt,
      expiresAt: existing.expiresAt,
      ...(existing.usedAt === undefined ? {} : { usedAt: existing.usedAt }),
    });
    while (kept.length > MAX_PRIOR_CREDENTIALS) {
      const launch = kept.reduce((a, b) => (b.issuedAt < a.issuedAt ? b : a));
      const reissues = kept.filter((prior) => prior !== launch);
      const unused = reissues.filter((prior) => prior.usedAt === undefined);
      const candidates = unused.length > 0 ? unused : reissues;
      const oldest = candidates.reduce((a, b) =>
        b.issuedAt < a.issuedAt ? b : a,
      );
      kept.splice(kept.indexOf(oldest), 1);
    }
    return kept;
  }

  private retainedDurablePriors(
    existing: RouteRecord | NestedRouteRecord,
  ): PriorCredential[] {
    if (existing.token !== undefined) return [];
    const issuedAt = this.now();
    return [
      ...(existing.priors ?? []).filter((prior) => prior.expiresAt > issuedAt),
      {
        tokenDigest: existing.tokenDigest,
        issuedAt,
        expiresAt: issuedAt + DURABLE_PRIOR_MAX_AGE_MS,
      },
    ].slice(-MAX_PRIOR_CREDENTIALS);
  }

  private credentialExpired(match: {
    record: RouteRecord | NestedRouteRecord;
    prior: PriorCredential | null;
  }): boolean {
    if (match.prior === null) return this.expired(match.record);
    if (match.record.lifetime !== "process")
      return match.prior.expiresAt <= this.now();
    return this.expired({ lifetime: "process", ...match.prior });
  }

  private async noteUse(
    use:
      | { nested: false; record: RouteRecord }
      | { nested: true; record: NestedRouteRecord },
    prior: PriorCredential | null,
  ): Promise<void> {
    const { record } = use;
    if (record.lifetime !== "process") {
      if (prior === null) await this.dropDurablePriors(use);
      return;
    }
    if (prior === null) {
      if (record.usedAt !== undefined) return;
      record.usedAt = this.now();
    } else {
      if (prior.usedAt !== undefined) return;
      prior.usedAt = this.now();
    }
    await this.serialize(async () => {
      if (use.nested) {
        if (this.nestedRoutes.get(this.nestedMapKey(use.record)) !== use.record)
          return;
        await this.persistCredential(this.nestedFile(use.record), use.record);
        return;
      }
      if (this.routes.get(this.routeMapKey(use.record)) !== use.record) return;
      await this.persistCredential(this.file(use.record), use.record);
    }).catch(() => undefined);
  }

  private async dropDurablePriors(
    use:
      | { nested: false; record: RouteRecord }
      | { nested: true; record: NestedRouteRecord },
  ): Promise<void> {
    const { record } = use;
    if (record.priors === undefined && !this.pendingPriorDrops.has(record))
      return;
    await this.serialize(async () => {
      const registered = use.nested
        ? this.nestedRoutes.get(this.nestedMapKey(use.record))
        : this.routes.get(this.routeMapKey(use.record));
      if (registered !== record) return;
      const index = use.nested ? this.nestedTokenIndex : this.tokenIndex;
      for (const prior of record.priors ?? []) index.delete(prior.tokenDigest);
      record.priors = undefined;
      this.pendingPriorDrops.add(record);
      await this.persistCredential(
        use.nested ? this.nestedFile(use.record) : this.file(use.record),
        record,
      );
      this.pendingPriorDrops.delete(record);
    }).catch(() => undefined);
  }

  private processLifetime(): {
    issuedAt: number;
    expiresAt: number;
  } {
    const issuedAt = this.now();
    return { issuedAt, expiresAt: issuedAt + PROCESS_CREDENTIAL_MAX_AGE_MS };
  }

  private lifetimeSound(record: {
    expiresAt?: number;
    issuedAt?: number;
  }): boolean {
    const { issuedAt, expiresAt } = record;
    return (
      issuedAt !== undefined &&
      expiresAt !== undefined &&
      expiresAt > issuedAt &&
      expiresAt - issuedAt <= PROCESS_CREDENTIAL_MAX_AGE_MS
    );
  }

  private expired(record: {
    lifetime?: "process";
    expiresAt?: number;
    issuedAt?: number;
  }): boolean {
    if (record.lifetime !== "process") return false;
    return !this.lifetimeSound(record) || (record.expiresAt ?? 0) <= this.now();
  }

  private restorable(record: {
    lifetime?: "process";
    expiresAt?: number;
    issuedAt?: number;
  }): boolean {
    if (record.lifetime !== "process") return true;
    return (
      record.issuedAt !== undefined &&
      record.issuedAt <= this.now() + PROCESS_CREDENTIAL_CLOCK_SKEW_MS &&
      !this.expired(record)
    );
  }

  private routeMapKey(
    route: ThreadRoute & { hostTokenDigest: string; lifetime?: "process" },
  ): string {
    return `${route.lifetime === "process" ? "process:" : ""}${this.key(route, route.hostTokenDigest)}`;
  }

  private nestedMapKey(
    route: NestedRoute & { hostTokenDigest: string; lifetime?: "process" },
  ): string {
    return `${route.lifetime === "process" ? "process:" : ""}${this.nestedKey(route, route.hostTokenDigest)}`;
  }

  private async removeProviderFiles(
    route: ThreadRoute & { hostTokenDigest: string },
    epoch: number,
  ): Promise<void> {
    await Promise.all([
      this.removeCredentialFile(this.fileAtEpoch(route, epoch)),
      this.removeCredentialFile(this.legacyFile(route)),
    ]);
  }

  private async removeCredentialFile(file: string): Promise<void> {
    try {
      await fs.rm(file, { force: true });
    } catch {
      await fs.rename(
        file,
        path.join(this.directory, `revoked-route-${randomUUID()}.json`),
      );
    }
  }

  private async quarantineUnreadableLegacyFiles(
    threadId: string,
    names: readonly string[],
  ): Promise<void> {
    const hostIds = (await this.hosts.list()).map((host) => host.hostId);
    for (const name of names) {
      if (
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      )
        continue;
      const file = path.join(this.directory, name);
      for (const hostId of hostIds) {
        if (name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)) continue;
        for (const provider of ["claude", "codex"] as const) {
          const prefix = `${LEGACY_THREAD_ROUTE_PREFIX}${hostId}-${provider}-`;
          if (!name.startsWith(prefix)) continue;
          const routeKey = name.slice(prefix.length);
          const suffix =
            /-(?:automatic|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})-[a-f0-9]{64}\.json$/u.exec(
              routeKey,
            );
          if (suffix === null || routeKey.slice(0, suffix.index) !== threadId)
            continue;
          const candidateCount = hostIds.filter((candidateHostId) => {
            const candidatePrefix = `${LEGACY_THREAD_ROUTE_PREFIX}${candidateHostId}-${provider}-`;
            if (!name.startsWith(candidatePrefix)) return false;
            const candidateKey = name.slice(candidatePrefix.length);
            const candidateSuffix =
              /-(?:automatic|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})-[a-f0-9]{64}\.json$/u.exec(
                candidateKey,
              );
            return candidateSuffix !== null;
          }).length;
          if (candidateCount === 1) await this.quarantineFile(file);
          break;
        }
      }
      const nestedMatches = hostIds.flatMap((candidateHostId) => {
        const prefix = `${LEGACY_NESTED_ROUTE_PREFIX}${candidateHostId}-`;
        if (!name.startsWith(prefix)) return [];
        const candidate = /^(.+)-([a-f0-9]{64})\.json$/u.exec(
          name.slice(prefix.length),
        );
        return candidate === null ? [] : [{ threadId: candidate[1] }];
      });
      if (
        name.startsWith(LEGACY_NESTED_ROUTE_PREFIX) &&
        nestedMatches.length === 1 &&
        nestedMatches[0]?.threadId === threadId
      )
        await this.quarantineFile(file);
    }
  }

  private async quarantineFile(file: string): Promise<void> {
    try {
      await fs.rename(
        file,
        path.join(this.directory, `revoked-route-${randomUUID()}.json`),
      );
    } catch {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  private legacyFile(route: ThreadRoute & { hostTokenDigest: string }): string {
    return path.join(
      this.directory,
      `${LEGACY_THREAD_ROUTE_PREFIX}${this.key(route, route.hostTokenDigest)}.json`,
    );
  }

  private nestedKey(route: NestedRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.threadId}-${hostTokenDigest}`;
  }

  private nestedFile(
    route: NestedRoute & { hostTokenDigest: string; lifetime?: "process" },
  ): string {
    return this.nestedFileAtEpoch(route, this.archiveEpoch(route.threadId));
  }

  private nestedFileAtEpoch(
    route: NestedRoute & { hostTokenDigest: string; lifetime?: "process" },
    epoch: number,
  ): string {
    const prefix =
      route.lifetime === "process"
        ? PROCESS_NESTED_ROUTE_PREFIX
        : NESTED_ROUTE_PREFIX;
    return path.join(
      this.directory,
      `${prefix}${this.nestedKey(route, route.hostTokenDigest)}-v${epoch}.json`,
    );
  }

  private archivedFile(threadId: string): string {
    return path.join(this.directory, this.archivedName(threadId));
  }

  private archiveFallbackFile(threadId: string): string {
    return path.join(this.directory, this.archiveFallbackName(threadId));
  }

  private archivedName(threadId: string): string {
    return `${ARCHIVED_THREAD_PREFIX}${digest(threadId)}.json`;
  }

  private archiveFallbackName(threadId: string): string {
    return `${ARCHIVE_FALLBACK_PREFIX}${digest(threadId)}.json`;
  }

  private archiveMarkerNames(threadId: string): string[] {
    const threadDigest = digest(threadId);
    return [
      `${ARCHIVED_THREAD_PREFIX}${threadDigest}.json`,
      `${ARCHIVE_FALLBACK_PREFIX}${threadDigest}.json`,
    ];
  }

  private hasMarkerFailure(threadId: string): boolean {
    return this.archiveMarkerNames(threadId).some(
      (name) =>
        this.corruptArchiveMarkers.has(name) ||
        this.transientArchiveReadFailures.has(name),
    );
  }

  private hasTransientArchiveReadFailure(threadId: string): boolean {
    return this.archiveMarkerNames(threadId).some((name) =>
      this.transientArchiveReadFailures.has(name),
    );
  }

  private clearMarkerFailures(threadId: string): void {
    for (const name of this.archiveMarkerNames(threadId)) {
      this.transientArchiveReadFailures.delete(name);
      this.corruptArchiveMarkers.delete(name);
    }
  }

  private archiveEpoch(threadId: string): number {
    return this.archiveEpochs.get(threadId) ?? 0;
  }

  private fileEpoch(name: string): number {
    const match = /-v([0-9]+)\.json$/u.exec(name);
    return match === null ? 0 : Number(match[1]);
  }

  private async isArchived(threadId: string): Promise<boolean> {
    const names = this.archiveMarkerNames(threadId);
    if (names.some((name) => this.corruptArchiveMarkers.has(name))) return true;
    if (names.some((name) => this.transientArchiveReadFailures.has(name))) {
      let resolved = false;
      for (const name of names) {
        if (!this.transientArchiveReadFailures.has(name)) continue;
        try {
          const text = await fs.readFile(
            path.join(this.directory, name),
            "utf8",
          );
          this.seenArchiveMarkers.add(name);
          this.applyArchiveState(name, text);
          resolved = true;
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            this.transientArchiveReadFailures.delete(name);
            continue;
          }
          this.transientArchiveReadFailures.add(name);
          return true;
        }
      }
      if (resolved && this.archivedThreads.has(threadId))
        this.expireUnreadablePending(threadId);
    }
    if (this.archivedThreads.has(threadId)) return true;
    if (this.activeArchiveMarkers.has(threadId)) return false;
    if (
      this.archiveMarkersLoaded &&
      !names.some((name) => this.seenArchiveMarkers.has(name))
    )
      return false;
    if (this.archiveMarkersLoaded && !this.hasMarkerFailure(threadId))
      return false;
    return this.hasMarkerFailure(threadId);
  }
}

function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readArchiveState(
  text: string,
): z.infer<typeof archiveStateSchema> | null {
  try {
    const parsed = archiveStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type CredentialRecord = {
  tokenDigest: string;
  priors?: readonly PriorCredential[];
};

function indexCredential<T extends CredentialRecord>(
  index: Map<string, T>,
  record: T,
): void {
  index.set(record.tokenDigest, record);
  for (const prior of record.priors ?? []) index.set(prior.tokenDigest, record);
}

function unindexCredential<T extends CredentialRecord>(
  index: Map<string, T>,
  record: T,
): void {
  index.delete(record.tokenDigest);
  for (const prior of record.priors ?? []) index.delete(prior.tokenDigest);
}

function lookup<T extends CredentialRecord>(
  index: ReadonlyMap<string, T>,
  token: string | null,
): { record: T; prior: PriorCredential | null } | null {
  if (token === null || token.length !== 43) return null;
  const presented = digest(token);
  const record = index.get(presented);
  if (record === undefined) return null;
  const matches = (stored: string) =>
    timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(stored, "hex"));
  if (matches(record.tokenDigest)) return { record, prior: null };
  for (const prior of record.priors ?? [])
    if (matches(prior.tokenDigest)) return { record, prior };
  return null;
}

async function readRecord<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = await fs.readFile(file, "utf8");
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
