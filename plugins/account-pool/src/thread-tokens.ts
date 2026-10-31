import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
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
const LEGACY_NESTED_ROUTE_PREFIX = "nested-route-";
const ARCHIVED_THREAD_PREFIX = "archived-thread-";
const ARCHIVE_FALLBACK_PREFIX = "archive-revocation-";
const REVOKED_ROUTE_PREFIX = "revoked-route-";
const SUSPENDED_FILE_PREFIX = "suspended-";
const DELETED_THREAD_PREFIX = "deleted-thread-";
const DELETED_THREAD_NAME = /^deleted-thread-([a-f0-9]{64})\.(?:json|d)$/u;
const DELETED_PENDING_PREFIX = "deleted-pending-";
const DELETED_PENDING_NAME = /^deleted-pending-([a-f0-9]{64})-/u;
const DELETED_THREAD_KEY = "deleted-thread:";

const THREAD_SWEEP_STATE = "thread-sweep.json";
const MAX_SWEEP_RETRIES = 256;

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const sweepRotationSchema = z
  .object({
    nextThreadId: identifierSchema,
    endThreadId: identifierSchema,
    startedAt: z.number().finite().nonnegative(),
    warned: z.boolean(),
    includeSuspended: z.boolean().default(false),
  })
  .strict();
const sweepRetrySchema = z
  .object({
    threadId: identifierSchema,
    attempts: z.number().int().positive(),
    lastFailureAt: z.number().finite().nonnegative(),
  })
  .strict();
const sweepStateSchema = z
  .object({
    rotation: sweepRotationSchema.nullable(),
    retries: z.array(sweepRetrySchema).default([]),
    retryOverflow: z.boolean().default(false),
  })
  .strict();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const archiveStateSchema = z
  .object({
    threadId: identifierSchema,
    epoch: z.number().int().nonnegative(),
    archived: z.boolean(),
    deleted: z.literal(true).optional(),
  })
  .strict();
const deletedRecordSchema = z
  .object({ threadDigest: digestSchema, deleted: z.literal(true) })
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

export type ThreadLookup = (
  threadId: string,
  signal?: AbortSignal,
) => Promise<"live" | "archived" | "gone">;
export const THREAD_STATE_LOOKUP_TIMEOUT_MS = 5_000;
export const UNANSWERED_WARNING_MS = 60_000;
export type DeletionRecords = Pick<PluginKvStorage, "set" | "list">;
export type ThreadSweepOptions = {
  signal?: AbortSignal;
  lookupTimeoutMs?: number;
};
export type ThreadSweepResult = {
  checked: number;
  revoked: number;
  failed: number;
  deferred: number;
};

export class ThreadTokenStore {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly tokenIndex = new Map<string, RouteRecord>();
  private readonly nestedRoutes = new Map<string, NestedRouteRecord>();
  private readonly nestedTokenIndex = new Map<string, NestedRouteRecord>();
  private readonly catalogTokenIndex = new Map<
    string,
    {
      hostId: string;
      provider: ThreadRoute["provider"];
      hostTokenDigest: string;
      issuedAt: number;
      expiresAt: number;
    }
  >();
  private readonly archivedThreads = new Set<string>();
  private readonly deletedThreadDigests = new Set<string>();
  private readonly recordedDeletions = new Set<string>();
  private readonly unrecordedThreads = new Set<string>();
  private readonly unrecordedPending = new Set<string>();
  private readonly heldDeletedFiles = new Map<string, Set<string>>();
  private deletionRecordsUnloaded = false;
  private readonly deletedLiveWarnings = new Map<string, number>();
  private readonly activeArchiveMarkers = new Set<string>();
  private readonly archiveEpochs = new Map<string, number>();
  private readonly seenArchiveMarkers = new Set<string>();
  private readonly transientArchiveReadFailures = new Set<string>();
  private readonly corruptArchiveMarkers = new Set<string>();
  private readonly archiveDurabilityFailures = new Set<string>();
  private archiveMarkersLoaded = false;
  private sweepRotation: z.infer<typeof sweepRotationSchema> | null = null;
  private sweepPersistenceFailed = false;
  private sweepRetryOverflow = false;
  private readonly sweepRetries = new Map<
    string,
    z.infer<typeof sweepRetrySchema>
  >();
  private readonly archiveVersions = new Map<string, number>();
  private readonly lastSuspensions = new Map<string, number>();
  private readonly unansweredWarnings = new Map<string, number>();
  private readonly pendingLookups = new Map<
    string,
    {
      version: number;
      flight: Promise<{
        status: "live" | "archived" | "gone";
        version: number;
      }>;
    }
  >();
  private tail: Promise<void> = Promise.resolve();
  private readonly pendingPriorDrops = new WeakSet<object>();
  private changeListener: (() => void) | null = null;

  constructor(
    private readonly directory: string,
    private readonly hosts: HubTokenStore,
    private readonly now: () => number = Date.now,
    private readonly threadState?: ThreadLookup,
    private readonly lookupTimeoutMs = THREAD_STATE_LOOKUP_TIMEOUT_MS,
    private readonly warn: (message: string) => void = () => {},
    private readonly deletions?: DeletionRecords,
  ) {}

  onCredentialsChanged(listener: () => void): void {
    this.changeListener = listener;
  }

  private credentialsChanged(): void {
    try {
      this.changeListener?.();
    } catch {
      return;
    }
  }

  async activeTokenDigests(hostId: string): Promise<string[]> {
    const digests = new Set<string>();
    for (const record of this.routes.values()) {
      if (record.hostId !== hostId || record.provider !== "claude") continue;
      if (await this.isArchived(record.threadId)) continue;
      if (!this.expired(record)) digests.add(record.tokenDigest);
      for (const prior of record.priors ?? [])
        if (!this.credentialExpired({ record, prior }))
          digests.add(prior.tokenDigest);
    }
    return [...digests];
  }

  async initialize(hostIds: readonly string[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const enrolled = new Set(hostIds);
    await this.loadDeletionRecords();
    const names = await fs.readdir(this.directory);
    const pending = new Set<string>();
    for (const name of names) {
      const deleted = DELETED_THREAD_NAME.exec(name);
      if (deleted?.[1] !== undefined) {
        this.deletedThreadDigests.add(deleted[1]);
        if (await this.confirmsDeletedRecord(name, deleted[1]))
          this.recordedDeletions.add(deleted[1]);
        else pending.add(deleted[1]);
      }
      const held = DELETED_PENDING_NAME.exec(name);
      if (held?.[1] !== undefined) {
        this.deletedThreadDigests.add(held[1]);
        pending.add(held[1]);
      }
    }
    for (const threadDigest of pending)
      await this.recordPendingDeletion(threadDigest, names);
    for (const name of names) {
      if (
        (name.startsWith(ARCHIVED_THREAD_PREFIX) ||
          name.startsWith(ARCHIVE_FALLBACK_PREFIX)) &&
        name.endsWith(".json")
      )
        await this.loadArchiveMarker(name);
    }
    this.archiveMarkersLoaded = true;
    for (const name of names) {
      await this.loadFile(name, enrolled).catch((error) => {
        if (error instanceof CredentialScrubError) throw error;
      });
    }
    const sweepState = names.includes(THREAD_SWEEP_STATE)
      ? await readRecord(
          path.join(this.directory, THREAD_SWEEP_STATE),
          sweepStateSchema,
        ).catch(() => {
          this.warn(
            "Account Pooler could not read sweep progress; starting a fresh rotation.",
          );
          return null;
        })
      : null;
    this.sweepRotation = sweepState?.rotation ?? null;
    this.sweepRetryOverflow =
      sweepState?.retryOverflow === true ||
      (sweepState?.retries.length ?? 0) > MAX_SWEEP_RETRIES;
    this.sweepRetries.clear();
    for (const retry of (sweepState?.retries ?? []).slice(0, MAX_SWEEP_RETRIES))
      this.sweepRetries.set(retry.threadId, retry);
  }

  private async loadDeletionRecords(): Promise<boolean> {
    if (this.deletions === undefined) return true;
    try {
      for (const key of await this.deletions.list(DELETED_THREAD_KEY)) {
        const threadDigest = digestSchema.safeParse(
          key.slice(DELETED_THREAD_KEY.length),
        );
        if (!key.startsWith(DELETED_THREAD_KEY) || !threadDigest.success)
          continue;
        this.deletedThreadDigests.add(threadDigest.data);
        this.recordedDeletions.add(threadDigest.data);
      }
      this.deletionRecordsUnloaded = false;
    } catch {
      this.deletionRecordsUnloaded = true;
    }
    return !this.deletionRecordsUnloaded;
  }

  private async recordPendingDeletion(
    threadDigest: string,
    names: readonly string[],
  ): Promise<void> {
    if (
      !this.recordedDeletions.has(threadDigest) &&
      !(await this.recordDeletion(threadDigest, null))
    ) {
      this.unrecordedPending.add(threadDigest);
      return;
    }
    this.unrecordedPending.delete(threadDigest);
    for (const name of names)
      if (name.startsWith(`${DELETED_PENDING_PREFIX}${threadDigest}-`))
        await fs
          .rm(path.join(this.directory, name), { force: true })
          .catch(() => undefined);
  }

  private async recordDeletion(
    threadDigest: string,
    marker: { threadId: string; epoch: number } | null,
    holdFiles: (() => Promise<void>) | null = null,
  ): Promise<boolean> {
    const writeDeleted = () =>
      this.persist(this.deletedFileOf(threadDigest), {
        threadDigest,
        deleted: true,
      }).then(
        () => true,
        () => false,
      );
    let filed = await writeDeleted();
    if (marker !== null) {
      const { threadId, epoch } = marker;
      const archived = { threadId, epoch, archived: true, deleted: true };
      for (const [file, name] of [
        [this.archivedFile(threadId), this.archivedName(threadId)],
        [
          this.archiveFallbackFile(threadId),
          this.archiveFallbackName(threadId),
        ],
      ] as const) {
        try {
          await this.persist(file, archived);
          this.seenArchiveMarkers.add(name);
          filed = true;
        } catch {}
      }
    }
    if (!filed) filed = await writeDeleted();
    if (!filed) filed = await this.createDeletedRecord(threadDigest);
    if (!filed) filed = await this.createDeletedDirectory(threadDigest);
    if (!filed && holdFiles !== null) await holdFiles();
    let recorded = false;
    if (this.deletions !== undefined)
      recorded = await this.deletions
        .set(`${DELETED_THREAD_KEY}${threadDigest}`, { deletedAt: this.now() })
        .then(
          () => true,
          () => false,
        );
    if (recorded || filed) this.recordedDeletions.add(threadDigest);
    return recorded || filed;
  }

  private async confirmsDeletedRecord(
    name: string,
    threadDigest: string,
  ): Promise<boolean> {
    if (name.endsWith(".d"))
      return this.syncDirectory().then(
        () => true,
        () => false,
      );
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(path.join(this.directory, name), "utf8"),
      );
      const parsed = deletedRecordSchema.safeParse(value);
      return (
        parsed.success &&
        parsed.data.threadDigest === threadDigest &&
        (await this.confirmsRecord(name))
      );
    } catch {
      return false;
    }
  }

  private async confirmsRecord(name: string): Promise<boolean> {
    try {
      const handle = await fs.open(path.join(this.directory, name), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory();
      return true;
    } catch {
      return false;
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
    if (this.corruptArchiveMarkers.has(name)) return;
    const parsed = archiveStateSchema.safeParse(JSON.parse(text));
    if (
      parsed.success &&
      parsed.data.deleted === true &&
      (await this.confirmsRecord(name))
    )
      this.recordedDeletions.add(digest(parsed.data.threadId));
  }

  private async loadFile(
    fileName: string,
    enrolled: ReadonlySet<string>,
    restoring = false,
  ): Promise<void> {
    let name = fileName;
    if (!name.endsWith(".json")) return;
    const file = path.join(this.directory, name);
    if (name.startsWith(REVOKED_ROUTE_PREFIX)) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      return;
    }
    if (name.startsWith(ARCHIVED_THREAD_PREFIX)) return;
    if (name.startsWith(DELETED_THREAD_PREFIX)) return;
    if (name.startsWith(DELETED_PENDING_PREFIX)) return;
    const suspended = name.startsWith(SUSPENDED_FILE_PREFIX);
    if (suspended) name = name.slice(SUSPENDED_FILE_PREFIX.length);
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
      if (record !== null && this.isDeleted(record.threadId)) {
        if (this.recordedDeletions.has(digest(record.threadId)))
          await fs.rm(file, { force: true });
        return;
      }
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
        this.restorable(record) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        if (suspended && !restoring) this.holdSuspended(record.threadId);
        this.routes.set(this.routeMapKey(record), record);
        indexCredential(this.tokenIndex, record);
      } else await fs.rm(file, { force: true });
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
      if (record !== null && this.isDeleted(record.threadId)) {
        if (this.recordedDeletions.has(digest(record.threadId)))
          await fs.rm(file, { force: true });
        return;
      }
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
        this.restorable(record) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        if (suspended && !restoring) this.holdSuspended(record.threadId);
        this.nestedRoutes.set(this.nestedMapKey(record), record);
        indexCredential(this.nestedTokenIndex, record);
      } else await fs.rm(file, { force: true });
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
    const admitted = await this.admit(parsed.threadId);
    return this.serialize(async () => {
      await this.requireDeletionRecords();
      if (this.isDeleted(parsed.threadId))
        throw new Error("Cannot mint a credential for a deleted thread.");
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      if (admitted === null)
        throw new Error(
          "Cannot mint a credential for a thread bb has not confirmed live.",
        );
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
      this.credentialsChanged();
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
    const admitted = await this.admit(parsed.threadId);
    return this.serialize(async () => {
      await this.requireDeletionRecords();
      if (this.isDeleted(parsed.threadId))
        throw new Error("Cannot mint a credential for a deleted thread.");
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      if (admitted === null)
        throw new Error(
          "Cannot mint a credential for a thread bb has not confirmed live.",
        );
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

  async forCatalog(
    hostId: string,
    provider: ThreadRoute["provider"],
    hostToken: string,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const { issuedAt, expiresAt } = this.processLifetime();
    this.catalogTokenIndex.set(digest(token), {
      hostId,
      provider,
      hostTokenDigest: digest(hostToken),
      issuedAt,
      expiresAt,
    });
    return token;
  }

  async authenticate(
    token: string | null,
    provider?: ThreadRoute["provider"],
  ): Promise<ThreadRoute | null> {
    const match = lookup(this.tokenIndex, token);
    if (match === null || this.credentialExpired(match)) return null;
    if (this.deletionRecordsUnloaded) return null;
    const { record } = match;
    const admitted = await this.admit(record.threadId);
    if (admitted === null) return null;
    if (provider !== undefined && provider !== record.provider) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    await this.noteUse({ nested: false, record }, match.prior);
    if (this.suspendedSince(record.threadId, admitted)) return null;
    return {
      hostId: record.hostId,
      threadId: record.threadId,
      provider: record.provider,
      accountId: record.accountId,
    };
  }

  async authenticateCatalog(
    token: string | null,
    provider: ThreadRoute["provider"],
  ): Promise<string | null> {
    if (token === null) return null;
    const tokenDigest = digest(token);
    const record = this.catalogTokenIndex.get(tokenDigest);
    if (
      record === undefined ||
      record.provider !== provider ||
      !this.lifetimeSound(record) ||
      record.expiresAt <= this.now()
    ) {
      this.catalogTokenIndex.delete(tokenDigest);
      return null;
    }
    return (await this.hosts.authenticateGeneration(
      record.hostId,
      record.hostTokenDigest,
    ))
      ? record.hostId
      : null;
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
    if (this.deletionRecordsUnloaded) return null;
    const { record } = match;
    const admitted = await this.admit(record.threadId);
    if (admitted === null) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    await this.noteUse({ nested: true, record }, match.prior);
    if (this.suspendedSince(record.threadId, admitted)) return null;
    return { hostId: record.hostId, threadId: record.threadId };
  }

  async removeThread(threadId: string): Promise<void> {
    this.commitArchiveState(
      threadId,
      () => {
        this.deletedThreadDigests.add(digest(threadId));
        this.archivedThreads.add(threadId);
        this.activeArchiveMarkers.delete(threadId);
      },
      true,
    );
    await this.serialize(async () => {
      const epoch = Math.max(
        this.archiveEpoch(threadId),
        await this.maxFileEpoch(threadId).catch(() => 0),
      );
      const nextEpoch = epoch + 1;
      this.commitArchiveState(threadId, () => {
        this.archiveEpochs.set(threadId, nextEpoch);
      });
      let names: string[] = [];
      let directoryReadFailed = false;
      try {
        names = await fs.readdir(this.directory);
      } catch {
        directoryReadFailed = true;
      }
      const holding =
        directoryReadFailed || this.holdsCredentials(threadId, names);
      let heldAside = false;
      const recorded = await this.persistDeletion(
        threadId,
        nextEpoch,
        holding,
        holding
          ? async () => {
              heldAside = true;
              await this.holdDeletedFiles(threadId, names, epoch);
            }
          : null,
      );
      if (heldAside)
        names = await fs.readdir(this.directory).catch(() => names);
      if (!recorded) {
        this.unrecordedThreads.add(threadId);
        throw new Error(
          `Account Pooler could not record the deletion of thread ${threadId}; it stays deleted in this process, its credential files are renamed to deleted-pending- files where renaming works and otherwise stay untouched, and the record is retried on the next event, sweep and start.`,
        );
      }
      this.unrecordedThreads.delete(threadId);
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        this.routes.delete(key);
        unindexCredential(this.tokenIndex, record);
        await this.removeProviderFiles(record, epoch).catch(() => undefined);
      }
      for (const [key, record] of this.nestedRoutes) {
        if (record.threadId !== threadId) continue;
        this.nestedRoutes.delete(key);
        unindexCredential(this.nestedTokenIndex, record);
        await this.removeNestedFiles(record, epoch).catch(() => undefined);
      }
      const threadDigest = digest(threadId);
      const held = this.heldDeletedFiles.get(threadId) ?? new Set<string>();
      this.heldDeletedFiles.delete(threadId);
      for (const name of [
        ...this.suspendedFiles(threadId, names),
        ...names.filter(
          (name) =>
            held.has(name) ||
            name.startsWith(`${DELETED_PENDING_PREFIX}${threadDigest}-`),
        ),
      ])
        await this.removeCredentialFile(path.join(this.directory, name)).catch(
          () => undefined,
        );
      await this.quarantineUnreadableLegacyFiles(threadId, names).catch(
        () => undefined,
      );
    });
  }

  private async persistDeletion(
    threadId: string,
    epoch: number,
    holding: boolean,
    holdFiles: (() => Promise<void>) | null,
  ): Promise<boolean> {
    const recorded = await this.recordDeletion(
      digest(threadId),
      holding ? { threadId, epoch } : null,
      holdFiles,
    );
    if (recorded) {
      this.clearMarkerFailures(threadId);
      this.archiveDurabilityFailures.delete(threadId);
    } else this.archiveDurabilityFailures.add(threadId);
    return recorded;
  }

  private async createDeletedRecord(threadDigest: string): Promise<boolean> {
    try {
      const handle = await fs.open(
        this.deletedFileOf(threadDigest),
        "w",
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify({ threadDigest, deleted: true }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory();
      return true;
    } catch {
      return false;
    }
  }

  private async createDeletedDirectory(threadDigest: string): Promise<boolean> {
    try {
      await fs
        .mkdir(
          path.join(
            this.directory,
            `${DELETED_THREAD_PREFIX}${threadDigest}.d`,
          ),
          { mode: 0o700 },
        )
        .catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        });
      await this.syncDirectory();
      return true;
    } catch {
      return false;
    }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await fs.open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async holdDeletedFiles(
    threadId: string,
    names: readonly string[],
    epoch: number,
  ): Promise<void> {
    const held = new Set([
      ...names.filter((name) => this.hasCredentialFile(threadId, [name])),
      ...this.suspendedFiles(threadId, names),
    ]);
    for (const [key, record] of this.routes) {
      if (record.threadId !== threadId) continue;
      this.routes.delete(key);
      unindexCredential(this.tokenIndex, record);
      held.add(path.basename(this.fileAtEpoch(record, epoch)));
      held.add(path.basename(this.legacyFile(record)));
    }
    for (const [key, record] of this.nestedRoutes) {
      if (record.threadId !== threadId) continue;
      this.nestedRoutes.delete(key);
      unindexCredential(this.nestedTokenIndex, record);
      held.add(path.basename(this.nestedFileAtEpoch(record, epoch)));
      held.add(path.basename(this.legacyNestedFile(record)));
    }
    const threadDigest = digest(threadId);
    let renamedAny = false;
    for (const name of held) {
      const file = path.join(this.directory, name);
      const renamed = await fs
        .rename(
          file,
          path.join(
            this.directory,
            `${DELETED_PENDING_PREFIX}${threadDigest}-${name}`,
          ),
        )
        .then(
          () => true,
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT",
        );
      if (renamed) {
        renamedAny = true;
        continue;
      }
      this.heldDeletedFiles.set(
        threadId,
        new Set([...(this.heldDeletedFiles.get(threadId) ?? []), name]),
      );
      this.warn(
        `Account Pooler could not rename credential file ${name} of deleted thread ${threadId}; it stays in place until a deletion record can be written.`,
      );
    }
    if (renamedAny)
      await this.syncDirectory().catch(() =>
        this.warn(
          `Account Pooler could not sync the deleted-pending renames of thread ${threadId}; they may not survive a power loss, and the deletion record is retried on the next event, sweep and start.`,
        ),
      );
  }

  async suspendThread(threadId: string): Promise<void> {
    this.commitArchiveState(
      threadId,
      () => {
        this.archivedThreads.add(threadId);
        this.activeArchiveMarkers.delete(threadId);
      },
      true,
    );
    await this.serialize(async () => {
      let names: string[] = [];
      let directoryReadFailed = false;
      try {
        names = await fs.readdir(this.directory);
      } catch {
        directoryReadFailed = true;
      }
      if (!directoryReadFailed && !this.holdsCredentials(threadId, names))
        return;
      const epoch = Math.max(
        this.archiveEpoch(threadId),
        directoryReadFailed ? 0 : this.maxEpochIn(threadId, names),
      );
      if (epoch !== this.archiveEpoch(threadId))
        this.commitArchiveState(threadId, () => {
          this.archiveEpochs.set(threadId, epoch);
        });
      try {
        await this.persistArchiveMarker(threadId, epoch, true);
      } catch (error) {
        for (const name of names)
          if (this.hasCredentialFile(threadId, [name]))
            await fs
              .rename(
                path.join(this.directory, name),
                path.join(this.directory, `${SUSPENDED_FILE_PREFIX}${name}`),
              )
              .catch(() => undefined);
        throw error;
      }
    });
  }

  private async requireDeletionRecords(): Promise<void> {
    if (!this.deletionRecordsUnloaded || (await this.loadDeletionRecords()))
      return;
    throw new Error(
      "Cannot mint a credential before Account Pooler has loaded its deletion records.",
    );
  }

  private async retryDeletionRecords(): Promise<void> {
    if (this.deletionRecordsUnloaded) await this.loadDeletionRecords();
    const threadIds = new Set(this.unrecordedThreads);
    for (const record of [
      ...this.routes.values(),
      ...this.nestedRoutes.values(),
    ])
      if (this.isDeleted(record.threadId)) threadIds.add(record.threadId);
    for (const threadId of threadIds)
      await this.removeThread(threadId).catch(() => undefined);
    if (this.unrecordedPending.size === 0) return;
    const names = await fs.readdir(this.directory).catch(() => null);
    if (names === null) return;
    for (const threadDigest of [...this.unrecordedPending])
      await this.serialize(() =>
        this.recordPendingDeletion(threadDigest, names),
      );
  }

  async sweepThreads(
    lookup: ThreadLookup,
    options: ThreadSweepOptions = {},
  ): Promise<ThreadSweepResult> {
    await this.retryDeletionRecords();
    const routed = new Set<string>();
    for (const record of this.routes.values()) routed.add(record.threadId);
    for (const record of this.nestedRoutes.values()) routed.add(record.threadId);
    let pruned = false;
    for (const id of this.sweepRetries.keys())
      if (!routed.has(id)) {
        this.sweepRetries.delete(id);
        pruned = true;
      }
    if (pruned) await this.saveSweepRotation(this.sweepRotation);
    const result: ThreadSweepResult = {
      checked: 0,
      revoked: 0,
      failed: 0,
      deferred: 0,
    };
    const cancelled = () => options.signal?.aborted === true;
    const attempted = new Set<string>();
    const failed = (threadId: string, retry: boolean) => {
      const previous = this.sweepRetries.get(threadId);
      if (previous !== undefined || this.sweepRetries.size < MAX_SWEEP_RETRIES) {
        if (retry) this.sweepRetries.delete(threadId);
        this.sweepRetries.set(threadId, {
          threadId,
          attempts: (previous?.attempts ?? 0) + 1,
          lastFailureAt: this.now(),
        });
      } else this.sweepRetryOverflow = true;
      result.failed += 1;
    };
    const check = async (threadId: string, retry = false): Promise<boolean> => {
      attempted.add(threadId);
      if (cancelled()) {
        result.deferred += 1;
        return false;
      }
      result.checked += 1;
      const timeoutMs = retry
        ? (options.lookupTimeoutMs ?? this.lookupTimeoutMs)
        : options.lookupTimeoutMs;
      const lookupSignals = [
        ...(options.signal === undefined ? [] : [options.signal]),
        ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]),
      ];
      const lookupSignal =
        lookupSignals.length === 0 ? undefined : AbortSignal.any(lookupSignals);
      const version = this.archiveVersion(threadId);
      let settled = false;
      let status: Awaited<ReturnType<ThreadLookup>>;
      try {
        const operation = Promise.resolve()
          .then(() => lookup(threadId, lookupSignal))
          .then(
            (value) => {
              settled = true;
              return value;
            },
            (error: unknown) => {
              settled = true;
              throw error;
            },
          );
        status = await untilAborted(operation, lookupSignal);
      } catch {
        if (cancelled() && !settled) {
          result.deferred += 1;
          return false;
        }
        failed(threadId, retry);
        return true;
      }
      try {
        if (status === "live") await this.restoreThread(threadId, version);
        else if (status === "archived")
          await this.suspendThreadIfVersion(threadId, version);
        else if (await this.removeThreadIfVersion(threadId, version))
          result.revoked += 1;
      } catch {
        failed(threadId, retry);
        return true;
      }
      this.sweepRetries.delete(threadId);
      return true;
    };
    const retries = [...this.sweepRetries.keys()].slice(0, 8);
    await Promise.all(retries.map((id) => check(id, true)));
    if (retries.length > 0) await this.saveSweepRotation(this.sweepRotation);
    const pending = this.sweepRotation;
    const needsSweep = (id: string) =>
      this.sweepRetryOverflow ||
      pending?.includeSuspended === true ||
      this.sweepRetries.has(id) ||
      !this.archivedThreads.has(id) ||
      (pending !== null &&
        id >= pending.nextThreadId &&
        id <= pending.endThreadId);
    const sorted = [...routed]
      .filter((id) => needsSweep(id) && !attempted.has(id))
      .sort();
    if (this.sweepRotation === null && sorted.length > 0) {
      const includeSuspended = this.sweepRetryOverflow;
      this.sweepRetryOverflow = false;
      await this.saveSweepRotation({
        nextThreadId: sorted[0]!,
        endThreadId: sorted[sorted.length - 1]!,
        startedAt: this.now(),
        warned: false,
        includeSuspended,
      });
    }
    const rotation = this.sweepRotation;
    const ordered =
      rotation === null
        ? []
        : sorted.filter(
            (id) => id >= rotation.nextThreadId && id <= rotation.endThreadId,
          );
    let next = 0;
    while (next < ordered.length && !cancelled()) {
      const batch = ordered.slice(next, next + 32);
      const completed = await Promise.all(batch.map((id) => check(id)));
      const incomplete = completed.indexOf(false);
      const resume = incomplete < 0 ? next + batch.length : next + incomplete;
      next += batch.length;
      if (rotation !== null) {
        const nextThreadId = ordered[resume];
        await this.saveSweepRotation(
          nextThreadId === undefined ? null : { ...rotation, nextThreadId },
        );
      }
    }
    const unreached = new Set(ordered.slice(next));
    for (const id of this.sweepRetries.keys())
      if (!attempted.has(id)) unreached.add(id);
    if (this.sweepRetryOverflow)
      for (const id of routed) unreached.add(id);
    result.deferred += unreached.size;
    if (ordered.length === 0 && rotation !== null)
      await this.saveSweepRotation(null);

    return result;
  }

  private async saveSweepRotation(
    rotation: z.infer<typeof sweepRotationSchema> | null,
  ): Promise<void> {
    const previous = this.sweepRotation;
    const warning =
      previous !== null &&
      !previous.warned &&
      this.now() - previous.startedAt > 60 * 60 * 1000;
    const saved =
      rotation === null
        ? null
        : {
            ...rotation,
            warned: rotation.warned || warning || previous?.warned === true,
          };
    await this.serialize(async () => {
      try {
        await this.persist(path.join(this.directory, THREAD_SWEEP_STATE), {
          rotation: saved,
          retries: [...this.sweepRetries.values()],
          retryOverflow: this.sweepRetryOverflow,
        });
        this.sweepPersistenceFailed = false;
      } catch {
        if (!this.sweepPersistenceFailed)
          this.warn(
            "Account Pooler could not save sweep progress; continuing with in-memory progress until storage recovers.",
          );
        this.sweepPersistenceFailed = true;
      }
      this.sweepRotation = saved;
    });
    if (warning)
      this.warn(
        "Account Pooler thread credential sweep rotation has taken more than one hour.",
      );
  }

  async removeThreadIfVersion(
    threadId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    if (this.archiveVersion(threadId) !== expectedVersion) return false;
    await this.removeThread(threadId);
    return true;
  }

  async suspendThreadIfVersion(
    threadId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    if (this.archiveVersion(threadId) !== expectedVersion) return false;
    await this.suspendThread(threadId);
    return true;
  }

  archiveVersion(threadId: string): number {
    return this.archiveVersions.get(threadId) ?? 0;
  }

  async unarchiveThread(threadId: string): Promise<boolean> {
    return (await this.settle(threadId, true)) !== null;
  }

  async settleThread(threadId: string): Promise<boolean> {
    return (await this.settle(threadId)) !== null;
  }

  private commitArchiveState(
    threadId: string,
    change: () => void,
    suspends = false,
  ): number {
    change();
    const version = this.archiveVersion(threadId) + 1;
    this.archiveVersions.set(threadId, version);
    if (suspends) this.lastSuspensions.set(threadId, version);
    this.credentialsChanged();
    return version;
  }

  private suspendedSince(threadId: string, version: number): boolean {
    return (this.lastSuspensions.get(threadId) ?? 0) > version;
  }

  async restoreThread(
    threadId: string,
    expectedVersion: number,
    unarchived = false,
  ): Promise<number | null> {
    return this.serialize(async () => {
      const current = () =>
        !this.isDeleted(threadId) &&
        !this.suspendedSince(threadId, expectedVersion);
      if (!current()) return null;
      if (
        this.activeArchiveMarkers.has(threadId) ||
        (this.archiveEpoch(threadId) === 0 &&
          !this.archivedThreads.has(threadId) &&
          !this.hasMarkerFailure(threadId) &&
          !this.archiveDurabilityFailures.has(threadId))
      ) {
        return unarchived
          ? this.commitArchiveState(threadId, () => {})
          : this.archiveVersion(threadId);
      }
      await this.isArchived(threadId);
      if (!current()) return null;
      if (this.hasTransientArchiveReadFailure(threadId)) return null;
      let names: string[] | null = null;
      try {
        names = await fs.readdir(this.directory);
      } catch {
        names = null;
      }
      if (!current()) return null;
      const epoch = Math.max(
        this.archiveEpoch(threadId),
        names === null ? 0 : this.maxEpochIn(threadId, names),
      );
      await this.persistArchiveMarker(threadId, epoch, false).catch(
        () => undefined,
      );
      if (names !== null) {
        for (const name of this.suspendedFiles(threadId, names)) {
          if (!current()) return null;
          await fs
            .rename(
              path.join(this.directory, name),
              path.join(
                this.directory,
                name.slice(SUSPENDED_FILE_PREFIX.length),
              ),
            )
            .catch(() => undefined);
        }
        if (!current()) return null;
        if (!this.hasLoadedCredentials(threadId))
          await this.loadThreadFiles(
            threadId,
            await fs.readdir(this.directory),
          );
      }
      if (!current()) return null;
      return this.commitArchiveState(threadId, () => {
        this.archivedThreads.delete(threadId);
        this.activeArchiveMarkers.add(threadId);
        this.archiveEpochs.set(
          threadId,
          Math.max(this.archiveEpoch(threadId), epoch),
        );
        this.clearMarkerFailures(threadId);
        this.archiveDurabilityFailures.delete(threadId);
      });
    });
  }

  private async admit(threadId: string): Promise<number | null> {
    if (this.threadState === undefined) {
      const version = this.archiveVersion(threadId);
      if (await this.isArchived(threadId)) return null;
      return this.suspendedSince(threadId, version) ? null : version;
    }
    try {
      return await this.settle(threadId);
    } catch (error) {
      this.warnUnanswered(threadId, error);
      return null;
    }
  }

  private async settle(
    threadId: string,
    unarchived = false,
  ): Promise<number | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = await this.askBb(threadId, unarchived);
      if (this.isDeleted(threadId)) {
        if (
          answer.status === "live" &&
          !this.suspendedSince(threadId, answer.version)
        )
          this.warnDeletedLive(threadId);
        return null;
      }
      if (answer.status === "live") {
        const version = await this.restoreThread(
          threadId,
          answer.version,
          unarchived,
        );
        if (version === null) continue;
        if (await this.isArchived(threadId)) return null;
        if (this.suspendedSince(threadId, version)) continue;
        return version;
      }
      try {
        const applied =
          answer.status === "archived"
            ? await this.suspendThreadIfVersion(threadId, answer.version)
            : await this.removeThreadIfVersion(threadId, answer.version);
        if (!applied) continue;
      } catch {}
      return null;
    }
    return null;
  }

  private askBb(
    threadId: string,
    fresh = false,
  ): Promise<{ status: "live" | "archived" | "gone"; version: number }> {
    const lookup = this.threadState;
    if (lookup === undefined) return Promise.reject(new Error("no lookup"));
    const version = this.archiveVersion(threadId);
    const pending = this.pendingLookups.get(threadId);
    if (!fresh && pending !== undefined && pending.version === version)
      return pending.flight;
    const signal = AbortSignal.timeout(this.lookupTimeoutMs);
    const flight = untilAborted(lookup(threadId, signal), signal)
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        return untilAborted(lookup(threadId, signal), signal);
      })
      .then((status) => ({ status, version }))
      .finally(() => {
        if (this.pendingLookups.get(threadId)?.flight === flight)
          this.pendingLookups.delete(threadId);
      });
    this.pendingLookups.set(threadId, { version, flight });
    return flight;
  }

  private isDeleted(threadId: string): boolean {
    return this.deletedThreadDigests.has(digest(threadId));
  }

  private warnDeletedLive(threadId: string): void {
    const warnedAt = this.deletedLiveWarnings.get(threadId);
    if (warnedAt !== undefined && this.now() - warnedAt < UNANSWERED_WARNING_MS)
      return;
    this.deletedLiveWarnings.set(threadId, this.now());
    this.warn(
      `Account Pooler kept thread ${threadId} deleted: bb reported it live after it was deleted, and a deleted thread's credentials are never restored or minted again.`,
    );
  }

  private warnUnanswered(threadId: string, error: unknown): void {
    const warnedAt = this.unansweredWarnings.get(threadId);
    if (warnedAt !== undefined && this.now() - warnedAt < UNANSWERED_WARNING_MS)
      return;
    this.unansweredWarnings.set(threadId, this.now());
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "timed out"
        : "failed";
    this.warn(
      `Account Pooler rejected a token for thread ${threadId}: bb's thread lookup ${reason}, so the thread could not be confirmed live.`,
    );
  }

  private holdSuspended(threadId: string): void {
    this.commitArchiveState(threadId, () => {
      this.archivedThreads.add(threadId);
      this.activeArchiveMarkers.delete(threadId);
    });
  }

  private suspendedFiles(threadId: string, names: readonly string[]): string[] {
    return names.filter(
      (name) =>
        name.startsWith(SUSPENDED_FILE_PREFIX) &&
        this.hasCredentialFile(threadId, [
          name.slice(SUSPENDED_FILE_PREFIX.length),
        ]),
    );
  }

  private async persistArchiveMarker(
    threadId: string,
    epoch: number,
    archived: boolean,
  ): Promise<void> {
    const marker = this.isDeleted(threadId)
      ? { threadId, epoch, archived: true, deleted: true }
      : { threadId, epoch, archived };
    try {
      await this.persist(this.archivedFile(threadId), marker);
      this.seenArchiveMarkers.add(this.archivedName(threadId));
      if (this.seenArchiveMarkers.has(this.archiveFallbackName(threadId)))
        await this.persist(this.archiveFallbackFile(threadId), marker);
    } catch (error) {
      if (!archived) throw error;
      try {
        await this.persist(this.archiveFallbackFile(threadId), marker);
        this.seenArchiveMarkers.add(this.archiveFallbackName(threadId));
      } catch {
        this.archiveDurabilityFailures.add(threadId);
        throw error;
      }
    }
    if (!archived) return;
    this.clearMarkerFailures(threadId);
    this.archiveDurabilityFailures.delete(threadId);
  }

  private holdsCredentials(
    threadId: string,
    names: readonly string[],
  ): boolean {
    return (
      this.archiveMarkerNames(threadId).some((name) =>
        this.seenArchiveMarkers.has(name),
      ) ||
      this.hasLoadedCredentials(threadId) ||
      this.hasCredentialFile(threadId, names) ||
      this.suspendedFiles(threadId, names).length > 0
    );
  }

  private hasLoadedCredentials(threadId: string): boolean {
    return (
      [...this.routes.values()].some(
        (record) => record.threadId === threadId,
      ) ||
      [...this.nestedRoutes.values()].some(
        (record) => record.threadId === threadId,
      )
    );
  }

  private async loadThreadFiles(
    threadId: string,
    names: readonly string[],
  ): Promise<void> {
    const enrolled = new Set(
      (await this.hosts.list()).map((host) => host.hostId),
    );
    const loaded = new Set([
      ...[...this.routes.values()].map((record) =>
        path.basename(this.file(record)),
      ),
      ...[...this.nestedRoutes.values()].map((record) =>
        path.basename(this.nestedFile(record)),
      ),
    ]);
    for (const name of names) {
      if (loaded.has(name) || !this.hasCredentialFile(threadId, [name]))
        continue;
      await this.loadFile(name, enrolled, true).catch(() => undefined);
    }
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

  private async persist(file: string, record: object): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      await this.syncDirectory();
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
    const threadId = parsed.data.threadId;
    if (parsed.data.deleted === true) {
      this.commitArchiveState(
        threadId,
        () => {
          this.deletedThreadDigests.add(digest(threadId));
          this.archivedThreads.add(threadId);
          this.activeArchiveMarkers.delete(threadId);
          this.archiveEpochs.set(
            threadId,
            Math.max(this.archiveEpoch(threadId), parsed.data.epoch),
          );
        },
        true,
      );
      return true;
    }
    const currentEpoch = this.archiveEpoch(threadId);
    const currentArchived = this.archivedThreads.has(threadId);
    if (parsed.data.epoch < currentEpoch) return currentArchived;
    if (parsed.data.epoch === currentEpoch && currentArchived) return true;
    this.commitArchiveState(threadId, () => {
      this.archiveEpochs.set(threadId, parsed.data.epoch);
      if (parsed.data.archived) {
        this.archivedThreads.add(threadId);
        this.activeArchiveMarkers.delete(threadId);
      } else {
        this.archivedThreads.delete(threadId);
        this.activeArchiveMarkers.add(threadId);
      }
    });
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
    return Math.max(
      this.archiveEpoch(threadId),
      this.maxEpochIn(threadId, await fs.readdir(this.directory)),
    );
  }

  private maxEpochIn(threadId: string, names: readonly string[]): number {
    let epoch = 0;
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
      this.credentialsChanged();
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

  private deletedFileOf(threadDigest: string): string {
    return path.join(
      this.directory,
      `${DELETED_THREAD_PREFIX}${threadDigest}.json`,
    );
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
    if (this.isDeleted(threadId)) return true;
    const version = this.archiveVersion(threadId);
    const names = this.archiveMarkerNames(threadId);
    if (names.some((name) => this.corruptArchiveMarkers.has(name))) return true;
    if (names.some((name) => this.transientArchiveReadFailures.has(name))) {
      for (const name of names) {
        if (!this.transientArchiveReadFailures.has(name)) continue;
        try {
          const text = await fs.readFile(
            path.join(this.directory, name),
            "utf8",
          );
          if (this.archiveVersion(threadId) !== version) return true;
          this.seenArchiveMarkers.add(name);
          this.applyArchiveState(name, text);
        } catch (error) {
          if (this.archiveVersion(threadId) !== version) return true;
          if (isNodeError(error) && error.code === "ENOENT") {
            this.transientArchiveReadFailures.delete(name);
            continue;
          }
          this.transientArchiveReadFailures.add(name);
          return true;
        }
      }
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
