import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, getThread, type DbConnection } from "@bb/db";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { toThreadResponseFromThread } from "../../src/services/threads/thread-runtime-display.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./seed.js";
import { createTestAppHarness, type TestAppHarness } from "./test-app.js";

const API = "/api/v1";
const WORKSPACE_PATH = "/workspace/account-pool-delete-matrix";
const PARENT_TOKEN_ENV = "BB_ACCOUNT_POOL_PARENT_TOKEN";
const POOL_CREDENTIAL_ENV = ["ANTHROPIC_AUTH_TOKEN", PARENT_TOKEN_ENV];
const RECORD_PREFIXES = [
  "deleted-thread-",
  "archived-thread-",
  "archive-revocation-",
];
const CREDENTIAL_NAME =
  /^(?:suspended-)?(?:scoped-route-|scoped-process-route-|thread-route-|scoped-nested-route-|scoped-process-nested-route-|nested-route-)/u;

type Lifetime = "durable" | "process";
type FaultClass = "kv" | "content" | "rename" | "rm" | "mkdir";
const FAULT_CLASSES: readonly FaultClass[] = [
  "kv",
  "content",
  "rename",
  "rm",
  "mkdir",
];
type ContentPoint = "open" | "write" | "sync" | "dirsync";
const CONTENT_POINTS: readonly ContentPoint[] = [
  "open",
  "write",
  "sync",
  "dirsync",
];
type Mutation = {
  method: string;
  target: string;
  ok: boolean;
  refused: boolean;
};
type Watch = {
  dataDir: string;
  directory: string;
  threadId: string;
  digest: string;
  kv: PluginKvStorage;
  violations: string[];
  unsynced: Set<string>;
  undurable: { from: string | null; to: string; previous: string | null }[];
};
type PoolRoute = {
  threadId: string;
  hostId: string;
  provider: "claude";
  accountId: null;
};
type NestedRoute = { threadId: string; hostId: string };
type PluginThreadTokens = {
  forThread(
    route: PoolRoute,
    hostToken: string,
    lifetime: Lifetime,
  ): Promise<string>;
  forNested(
    route: NestedRoute,
    hostToken: string,
    lifetime: Lifetime,
  ): Promise<string>;
};
type PluginHostTokens = { forHost(hostId: string): Promise<string> };
type Patchable = Record<string, (...args: unknown[]) => unknown>;
type Server = {
  db: DbConnection;
  harness: TestAppHarness | null;
  sdk: ReturnType<typeof createBbSdk>;
};
type Started = {
  pool: FakePluginHost;
  threadTokens: PluginThreadTokens;
  hostTokens: PluginHostTokens;
};
type Outcome = { token: boolean; mint: boolean; exported: boolean };

const pluginSource = (file: string) =>
  new URL(`../../../../plugins/account-pool/src/${file}`, import.meta.url).href;

const captured: {
  threadTokens: PluginThreadTokens | null;
  hostTokens: PluginHostTokens | null;
  sweep: Promise<unknown> | null;
} = { threadTokens: null, hostTokens: null, sweep: null };
const sweeping = () => captured.sweep;
const unpatch: (() => void)[] = [];
let plugin: (bb: BbPluginApi) => Promise<void>;

function patch(
  prototype: Patchable,
  method: string,
  record: (self: unknown, result: unknown) => void,
): void {
  const original = prototype[method];
  if (original === undefined) throw new Error(`no ${method} to observe`);
  prototype[method] = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    record(this, result);
    return result;
  };
  unpatch.push(() => {
    prototype[method] = original;
  });
}

async function observePlugin(): Promise<void> {
  const tokens = await import(pluginSource("thread-tokens.ts"));
  const store = await import(pluginSource("store.ts"));
  const server = await import(pluginSource("server.ts"));
  patch(tokens.ThreadTokenStore.prototype, "initialize", (self) => {
    captured.threadTokens = self as PluginThreadTokens;
  });
  patch(tokens.ThreadTokenStore.prototype, "sweepThreads", (_, result) => {
    captured.sweep = result as Promise<unknown>;
  });
  patch(store.HubTokenStore.prototype, "initialize", (self) => {
    captured.hostTokens = self as PluginHostTokens;
  });
  const createAccountPoolPlugin: (options: {
    now: () => number;
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
  }) => (bb: BbPluginApi) => Promise<void> = server.createAccountPoolPlugin;
  plugin = createAccountPoolPlugin({
    now: Date.now,
    env: {},
    fetch: async () => Response.json({}, { status: 200 }),
  });
}

function stopObserving(): void {
  for (const restore of unpatch.splice(0).reverse()) restore();
  setPluginThreadEventEmitter(undefined);
}

function realSdk(harness: TestAppHarness) {
  return createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://localhost",
      runtime: "node",
      fetch: async (input, init) => harness.app.fetch(new Request(input, init)),
    }),
  });
}

async function restartServer(previous: Server): Promise<Server> {
  const db = createConnection(previous.db.$client.serialize());
  const harness = await createTestAppHarness({ db });
  if (previous.harness !== null) {
    await previous.harness.cleanup();
    previous.db.$client.close();
  }
  return { db, harness, sdk: realSdk(harness) };
}

async function stopServer(server: Server): Promise<void> {
  if (server.harness === null) return;
  await server.harness.cleanup();
  server.db.$client.close();
}

function isCredential(watch: Watch, name: string): boolean {
  return CREDENTIAL_NAME.test(name) && name.includes(watch.threadId);
}

async function durableRecords(
  watch: Watch,
): Promise<{ other: boolean; pending: boolean }> {
  const names = existsSync(watch.directory) ? readdirSync(watch.directory) : [];
  const durable = (name: string) =>
    names.includes(name) &&
    !watch.unsynced.has(name) &&
    !watch.undurable.some((entry) => entry.to === name);
  const deletedMarker = (name: string, digest: boolean) => {
    if (!durable(name)) return false;
    try {
      const value = JSON.parse(
        readFileSync(path.join(watch.directory, name), "utf8"),
      );
      return (
        value.deleted === true &&
        (!digest || value.threadDigest === watch.digest)
      );
    } catch {
      return false;
    }
  };
  const row = `deleted-thread:${watch.digest}`;
  return {
    other:
      (await watch.kv.list(row)).includes(row) ||
      deletedMarker(`deleted-thread-${watch.digest}.json`, true) ||
      durable(`deleted-thread-${watch.digest}.d`) ||
      deletedMarker(`archived-thread-${watch.digest}.json`, false) ||
      deletedMarker(`archive-revocation-${watch.digest}.json`, false),
    pending: names.some(
      (name) =>
        name.startsWith(`deleted-pending-${watch.digest}-`) && durable(name),
    ),
  };
}

function losePower(watch: Watch): void {
  for (const entry of watch.undurable.reverse()) {
    const to = path.join(watch.directory, entry.to);
    if (entry.from === null) rmSync(to, { recursive: true, force: true });
    else if (existsSync(to)) {
      renameSync(to, path.join(watch.directory, entry.from));
      if (entry.previous !== null) writeFileSync(to, entry.previous);
    }
  }
  for (const name of watch.unsynced) {
    const file = path.join(watch.directory, name);
    if (existsSync(file) && statSync(file).isFile()) truncateSync(file, 0);
  }
  watch.undurable.length = 0;
  watch.unsynced.clear();
}

async function checkRemoval(
  watch: Watch,
  method: string,
  args: readonly unknown[],
): Promise<void> {
  const source = String(args[0]);
  if (!["rm", "unlink", "rename"].includes(method) || !existsSync(source))
    return;
  const name = path.basename(source);
  const target = method === "rename" ? path.basename(String(args[1])) : null;
  const removesPending = name.startsWith("deleted-pending-");
  const removesCredential =
    isCredential(watch, name) &&
    (target === null ||
      (!CREDENTIAL_NAME.test(target) &&
        !target.startsWith("deleted-pending-")));
  if (!removesPending && !removesCredential) return;
  const records = await durableRecords(watch);
  if (removesPending ? records.other : records.other || records.pending) return;
  watch.violations.push(
    `${method} ${name}${target === null ? "" : ` -> ${target}`} while no ${removesPending ? "other " : ""}deletion record was durable`,
  );
}

const overrides: (() => void)[] = [];

function override<T extends object, K extends keyof T>(
  target: T,
  method: K,
  implementation: T[K],
): void {
  const original = target[method];
  target[method] = implementation;
  overrides.push(() => {
    target[method] = original;
  });
}

function restoreFaults(): void {
  for (const restore of overrides.splice(0).reverse()) restore();
}

function injectFaults(
  watch: Watch,
  faults: ReadonlySet<FaultClass>,
  crashAfter = Number.POSITIVE_INFINITY,
  point: ContentPoint = "open",
): Mutation[] {
  const mutations: Mutation[] = [];
  let crashed = false;
  const crash = () => {
    crashed = true;
    throw Object.assign(new Error("simulated crash"), { code: "EIO" });
  };
  const attempt = async <T>(
    method: string,
    target: unknown,
    fault: FaultClass | null,
    run: () => Promise<T>,
    args: readonly unknown[] = [],
  ): Promise<T> => {
    const mutation = {
      method,
      target: path.basename(String(target)),
      ok: false,
      refused: false,
    };
    mutations.push(mutation);
    if (crashed || mutations.length > crashAfter) crash();
    if (fault !== null && faults.has(fault)) {
      mutation.refused = true;
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    await checkRemoval(watch, method, args);
    const result = await run();
    mutation.ok = true;
    return result;
  };
  const inside = (file: unknown) =>
    path.resolve(String(file)).startsWith(`${watch.dataDir}${path.sep}`);
  const watched = (file: unknown) =>
    path.dirname(path.resolve(String(file))) === path.resolve(watch.directory);
  const isRecord = (file: unknown) =>
    RECORD_PREFIXES.some((prefix) =>
      path.basename(String(file)).startsWith(prefix),
    );
  const contentFault = (file: unknown, at: ContentPoint) =>
    isRecord(file) && point === at ? "content" : null;
  const kv = watch.kv;
  const originalSet = kv.set.bind(kv);
  override(kv, "set", async (key, value) => {
    if (!key.startsWith("deleted-thread:")) {
      if (crashed) crash();
      return originalSet(key, value);
    }
    return attempt("kv", key, "kv", () => originalSet(key, value));
  });
  const originalDelete = kv.delete.bind(kv);
  override(kv, "delete", async (key) => {
    if (crashed) crash();
    return originalDelete(key);
  });
  const originalOpen = fs.open.bind(fs);
  const handled = (
    file: unknown,
    handle: Awaited<ReturnType<typeof fs.open>>,
    writing: boolean,
  ) => {
    const name = path.basename(String(file));
    const directory = !writing && statSync(String(file)).isDirectory();
    const writeFile = handle.writeFile.bind(handle);
    return Object.assign(handle, {
      writeFile: (async (data: string) =>
        attempt("write", file, contentFault(file, "write"), async () => {
          await writeFile(data);
          if (watched(file)) watch.unsynced.add(name);
        })) as typeof handle.writeFile,
      sync: async () => {
        await attempt(
          directory ? "dirsync" : "sync",
          file,
          directory
            ? point === "dirsync"
              ? "content"
              : null
            : contentFault(file, "sync"),
          async () => {
            if (!directory) watch.unsynced.delete(name);
            else if (
              path.resolve(String(file)) === path.resolve(watch.directory)
            )
              watch.undurable.length = 0;
          },
        );
      },
    });
  };
  override(fs, "open", async (file, flags, mode) => {
    if (!inside(file)) return originalOpen(file, flags, mode);
    if (flags === undefined || flags === "r")
      return handled(file, await originalOpen(file, flags, mode), false);
    const existed = existsSync(String(file));
    return attempt("open", file, contentFault(file, "open"), async () => {
      const handle = await originalOpen(file, flags, mode);
      if (watched(file)) {
        watch.unsynced.add(path.basename(String(file)));
        if (!existed)
          watch.undurable.push({
            from: null,
            to: path.basename(String(file)),
            previous: null,
          });
      }
      return handled(file, handle, true);
    });
  });
  for (const [method, fault] of [
    ["rename", "rename"],
    ["rm", "rm"],
    ["unlink", "rm"],
    ["mkdir", "mkdir"],
    ["chmod", null],
    ["writeFile", null],
  ] as const) {
    const original = (
      fs[method] as (...args: unknown[]) => Promise<unknown>
    ).bind(fs);
    override(fs, method, (async (...args: unknown[]) => {
      if (!inside(args[0]) && !(method === "rename" && inside(args[1])))
        return original(...args);
      return attempt(
        method,
        method === "rename" ? args[1] : args[0],
        method === "mkdir" &&
          !path.basename(String(args[0])).startsWith("deleted-thread-")
          ? null
          : fault,
        async () => {
          const target = String(method === "rename" ? args[1] : args[0]);
          const existed = existsSync(target);
          const previous =
            method === "rename" && existed && statSync(target).isFile()
              ? readFileSync(target, "utf8")
              : null;
          const result = await original(...args);
          if ((method === "rm" || method === "unlink") && watched(args[0]))
            watch.unsynced.delete(path.basename(String(args[0])));
          if (watched(target)) {
            const to = path.basename(target);
            if (method === "rename") {
              const from = path.basename(String(args[0]));
              if (watch.unsynced.delete(from)) watch.unsynced.add(to);
              else watch.unsynced.delete(to);
              watch.undurable.push({ from, to, previous });
            }
            if (method === "mkdir" && !existed)
              watch.undurable.push({ from: null, to, previous: null });
          }
          return result;
        },
        args,
      );
    }) as never);
  }
  return mutations;
}

function faultSubsets(): Set<FaultClass>[] {
  const subsets: Set<FaultClass>[] = [];
  for (let mask = 0; mask < 1 << FAULT_CLASSES.length; mask += 1)
    subsets.push(
      new Set(FAULT_CLASSES.filter((_, bit) => (mask & (1 << bit)) !== 0)),
    );
  return subsets;
}

function faultLabel(
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
): string {
  return (
    [...faults]
      .map((fault) => (fault === "content" ? `content@${point}` : fault))
      .join("+") || "none"
  );
}

const yes = (value: boolean) => (value ? "yes" : "no");

type World = {
  base: TestAppHarness;
  hostId: string;
  projectId: string;
  environmentId: string;
  host: ReturnType<typeof seedHostSession>["host"];
  deliveries: Promise<{ errors: unknown[] }>[];
  current: { pool: FakePluginHost | null };
};

function deliverDeletes(world: World): void {
  const ignore = () => {};
  setPluginThreadEventEmitter({
    emitThreadEvents: ignore,
    emitTerminalInput: ignore,
    emitHostDeleted: ignore,
    emitEnvironmentRemoved: ignore,
    emitThreadCreated: ignore,
    emitThreadActive: ignore,
    emitThreadIdle: ignore,
    emitThreadFailed: ignore,
    emitThreadArchived: ignore,
    emitThreadDeleted: (deleted) => {
      const pool = world.current.pool;
      if (pool === null) throw new Error("no plugin host to deliver to");
      world.deliveries.push(
        pool.harness.behavior.emitThreadEvent("thread.deleted", {
          thread: toThreadResponseFromThread(
            { db: world.base.db, hub: world.base.deps.hub },
            { thread: deleted },
          ),
        }),
      );
    },
    emitInteractionPending: ignore,
    emitMessageQueued: ignore,
    emitMessageDispatched: ignore,
    emitMessageCancelled: ignore,
    emitThreadUnarchived: ignore,
    emitThreadParentChanged: ignore,
    emitTurnFailed: ignore,
  });
}

function seedWorld(base: TestAppHarness): World {
  const { host } = seedHostSession(base.deps, { id: "host-pool-matrix" });
  const { project } = seedProjectWithSource(base.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(base.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const world: World = {
    base,
    host,
    hostId: host.id,
    projectId: project.id,
    environmentId: environment.id,
    deliveries: [],
    current: { pool: null },
  };
  deliverDeletes(world);
  return world;
}

async function deletionOutcome(
  world: World,
  lifetime: Lifetime,
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
  files: 1 | 2,
  crash: { during: "delete" | "restart"; after: number } | null,
) {
  const thread = seedThread(world.base.deps, {
    environmentId: world.environmentId,
    projectId: world.projectId,
  });
  const root = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const dataDir = await fs.mkdtemp(path.join(root, "bb-pool-matrix-"));
  let server: Server = {
    db: world.base.db,
    harness: null,
    sdk: realSdk(world.base),
  };
  const lookups: string[] = [];
  const pool0 = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [world.host] },
      system: { providerStates: async () => ({ providers: [] }) },
      threads: {
        get: async (args: { threadId: string; signal?: AbortSignal }) => {
          lookups.push(args.threadId);
          return server.sdk.threads.get(args);
        },
      },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
    },
  });
  const watch: Watch = {
    dataDir,
    directory: path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    ),
    threadId: thread.id,
    digest: createHash("sha256").update(thread.id).digest("hex"),
    kv: pool0.bb.storage.kv,
    violations: [],
    unsynced: new Set(),
    undurable: [],
  };
  const capture = (pool: FakePluginHost): Started => {
    if (captured.threadTokens === null || captured.hostTokens === null)
      throw new Error("the plugin's token stores were not observed");
    return {
      pool,
      threadTokens: captured.threadTokens,
      hostTokens: captured.hostTokens,
    };
  };
  const route: PoolRoute = {
    threadId: thread.id,
    hostId: world.hostId,
    provider: "claude",
    accountId: null,
  };
  const nestedRoute: NestedRoute = {
    threadId: thread.id,
    hostId: world.hostId,
  };
  const context = {
    threadId: thread.id,
    projectId: thread.projectId,
    hostId: world.hostId,
    ...(lifetime === "process"
      ? { experimental_runtimeKind: "native" as const }
      : {}),
  };
  const exportEntries = async (pool: FakePluginHost) =>
    (await pool.harness.behavior.resolveProviderEnv("claude-code", context))
      .filter((entry) => POOL_CREDENTIAL_ENV.includes(entry.name))
      .filter(
        (entry) => typeof entry.value === "string" && entry.value.length > 0,
      );
  const threadTokenAccepted = async (pool: FakePluginHost, token: string) =>
    (
      await pool.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "claude-opus-4-1", messages: [] }),
      })
    ).status !== 401;
  const nestedTokenAccepted = async (pool: FakePluginHost, token: string) =>
    (
      await pool.harness.behavior.fetchHttp("GET", "/availability", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status !== 401;
  const credentialFiles = () =>
    (existsSync(watch.directory) ? readdirSync(watch.directory) : []).filter(
      (name) => isCredential(watch, name),
    );
  let started: Started | null = null;
  const restart = async (
    crashAt: number | undefined,
    sweep: boolean,
  ): Promise<Mutation[]> => {
    if (started === null) throw new Error("no plugin host to restart");
    server = await restartServer(server);
    let mutations: Mutation[] = [];
    let atFactoryEnd = 0;
    const previous: Started = started;
    try {
      const pool = await previous.pool.harness.lifecycle.reload(async (bb) => {
        restoreFaults();
        losePower(watch);
        watch.kv = bb.storage.kv;
        captured.threadTokens = null;
        captured.hostTokens = null;
        mutations = injectFaults(watch, new Set(), crashAt);
        await plugin(bb);
        atFactoryEnd = mutations.length;
      });
      if (mutations.length !== atFactoryEnd)
        watch.violations.push(
          "the previous plugin instance mutated its data directory while it was being replaced",
        );
      started = capture(pool);
      world.current.pool = pool;
      if (sweep) {
        captured.sweep = null;
        pool.harness.behavior.runService("hub");
        const sweep = sweeping();
        if (sweep === null)
          throw new Error("the start did not sweep the thread credentials");
        await sweep.catch(() => undefined);
      }
    } catch (error) {
      if (crashAt === undefined) throw error;
    }
    restoreFaults();
    return mutations;
  };
  const probe = async (): Promise<Outcome & { lookups: number }> => {
    if (started === null) throw new Error("no plugin host to probe");
    const { pool, threadTokens, hostTokens } = started;
    lookups.length = 0;
    const hostToken = await hostTokens.forHost(world.hostId);
    const minted = [
      await threadTokens.forThread(route, hostToken, lifetime).then(
        () => true,
        () => false,
      ),
      await threadTokens.forNested(nestedRoute, hostToken, lifetime).then(
        () => true,
        () => false,
      ),
    ];
    const exported = (await exportEntries(pool)).length > 0;
    const token =
      (await threadTokenAccepted(pool, tokens.token)) ||
      (tokens.nested !== null &&
        (await nestedTokenAccepted(pool, tokens.nested)));
    const rows = lookups.filter((threadId) => threadId === thread.id).length;
    return { token, mint: minted.some(Boolean), exported, lookups: rows };
  };
  const tokens: { token: string; nested: string | null } = {
    token: "",
    nested: null,
  };
  try {
    captured.threadTokens = null;
    captured.hostTokens = null;
    await plugin(pool0.bb);
    started = capture(pool0);
    world.current.pool = pool0;
    await pool0.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "test-account" },
      label: null,
      priority: 1,
    });
    if (files === 2) {
      const entries = await exportEntries(pool0);
      const token = entries.find(
        (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
      )?.value;
      const nested = entries.find(
        (entry) => entry.name === PARENT_TOKEN_ENV,
      )?.value;
      if (typeof token !== "string" || typeof nested !== "string")
        throw new Error("the env export did not mint both tokens");
      tokens.token = token;
      tokens.nested = nested;
    } else {
      tokens.token = await started.threadTokens.forThread(
        route,
        await started.hostTokens.forHost(world.hostId),
        lifetime,
      );
    }
    expect(credentialFiles()).toHaveLength(files);
    expect(await threadTokenAccepted(pool0, tokens.token)).toBe(true);
    if (tokens.nested !== null)
      expect(await nestedTokenAccepted(pool0, tokens.nested)).toBe(true);

    watch.kv = pool0.bb.storage.kv;
    deliverDeletes(world);
    const deleteMutations = injectFaults(
      watch,
      faults,
      crash?.during === "delete" ? crash.after : undefined,
      point,
    );
    const deleted = await world.base.app.request(
      `${API}/threads/${thread.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadsConfirmed: false }),
      },
    );
    const deliveries = world.deliveries.splice(0);
    await Promise.all(deliveries);
    restoreFaults();
    expect(deleted.status).toBe(200);
    const durable = await durableRecords(watch);

    await restart(undefined, false);
    const committed = getThread(server.db, thread.id)?.deletedAt ?? null;
    injectFaults(watch, new Set());
    const first = await probe();
    restoreFaults();
    if (crash?.during === "restart") await restart(crash.after, true);
    const restartMutations = await restart(undefined, true);
    injectFaults(watch, new Set());
    const last = await probe();
    restoreFaults();
    return {
      outcome: {
        token: first.token || last.token,
        mint: first.mint || last.mint,
        exported: first.exported || last.exported,
      },
      committed: committed !== null,
      delivered: deliveries.length,
      asked: first.lookups > 0 && last.lookups > 0,
      recorded: durable.other || durable.pending,
      kvRefused: deleteMutations.some(
        (mutation) => mutation.method === "kv" && mutation.refused,
      ),
      deleteMutations,
      restartMutations,
      violations: watch.violations,
    };
  } finally {
    restoreFaults();
    world.current.pool = null;
    const last: Started | null = started;
    if (last !== null) await last.pool.harness.lifecycle.dispose();
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export function describeDeletionMatrix(lifetime: Lifetime, files: 1 | 2): void {
  describe(`Account Pooler deletion matrix through bb's real delete route (${lifetime} credentials, ${files} credential file${files === 1 ? "" : "s"})`, () => {
    beforeAll(observePlugin);
    afterAll(stopObserving);
    it("refuses every old token, mint and env export for every subset of refused plugin kv, content, rename, rm and directory mutations, content refused at its open, write, file sync or directory sync, and every crash point of the delete and of the next start, losing every unsynced change at each restart, minting first on a start that has not swept yet, with every lookup after the delete read by the real SDK from the thread row of a bb server restarted on its serialized database", async () => {
      const base = await createTestAppHarness();
      const rows: string[] = [];
      const runs: number[] = [];
      const violations: string[] = [];
      const failures: string[] = [];
      try {
        const world = seedWorld(base);
        for (const faults of faultSubsets())
          for (const point of faults.has("content")
            ? CONTENT_POINTS
            : (["open"] as const)) {
            const cell = `${lifetime} | ${files} file${files === 1 ? "" : "s"} | refused: ${faultLabel(faults, point)}`;
            const outcomes: Outcome[] = [];
            const note = (
              at: string,
              run: Awaited<ReturnType<typeof deletionOutcome>>,
            ) => {
              violations.push(
                ...run.violations.map((v) => `${cell} ${at}: ${v}`),
              );
              outcomes.push(run.outcome);
              if (
                run.outcome.token ||
                run.outcome.mint ||
                run.outcome.exported ||
                !run.committed ||
                run.delivered !== 1 ||
                !run.asked
              )
                failures.push(
                  `${cell} | ${at} | durable record before the crash: ${yes(run.recorded)} | kv write refused before the crash: ${yes(run.kvRefused)} | deletedAt committed in the restarted database: ${yes(run.committed)} | thread.deleted deliveries: ${run.delivered} | bb asked after both starts: ${yes(run.asked)} | old token accepted: ${yes(run.outcome.token)} | mint succeeds: ${yes(run.outcome.mint)} | export carries a pool credential: ${yes(run.outcome.exported)}`,
                );
            };
            const first = await deletionOutcome(
              world,
              lifetime,
              faults,
              point,
              files,
              null,
            );
            note("completed", first);
            expect(first.deleteMutations.length).toBeGreaterThan(0);
            for (
              let after = 0;
              after < first.deleteMutations.length;
              after += 1
            )
              note(
                `delete@${after}`,
                await deletionOutcome(world, lifetime, faults, point, files, {
                  during: "delete",
                  after,
                }),
              );
            for (
              let after = 0;
              after < first.restartMutations.length;
              after += 1
            )
              note(
                `restart@${after}`,
                await deletionOutcome(world, lifetime, faults, point, files, {
                  during: "restart",
                  after,
                }),
              );
            rows.push(
              `${cell} | durable record: ${yes(first.recorded)} | old token accepted: ${yes(outcomes.some((o) => o.token))} | mint succeeds: ${yes(outcomes.some((o) => o.mint))} | export carries a pool credential: ${yes(outcomes.some((o) => o.exported))} | runs: ${outcomes.length}`,
            );
            runs.push(outcomes.length);
          }
      } finally {
        await base.cleanup();
      }
      const label = `${lifetime}, ${files} file${files === 1 ? "" : "s"}`;
      process.stdout.write(
        `${[
          `deletion matrix through bb's real delete route (${label}); every unsynced change is lost at each restart, the first start mints, exports and authenticates before any sweep, and every lookup after the delete reads bb's restarted database through the real SDK:`,
          ...rows,
          "",
          `runs that accepted an old token, minted, exported a pool credential, lost the committed delete, did not receive exactly one thread.deleted or never asked bb (${label}: ${failures.length}):`,
          ...failures,
          "",
          `invariant violations (${label}: ${violations.length}):`,
          ...violations,
          "",
          `worker memory (${label}): heap used ${Math.round(process.memoryUsage().heapUsed / 1_048_576)} MB at the end, peak resident ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`,
        ].join("\n")}\n`,
      );
      expect(violations).toEqual([]);
      expect(failures).toEqual([]);
      expect(rows).toHaveLength(80);
      expect(runs.every((count) => count > 1)).toBe(true);
    }, 1_200_000);
  });
}
