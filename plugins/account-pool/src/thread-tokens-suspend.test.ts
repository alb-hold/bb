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
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubTokenStore } from "./store.js";
import {
  ThreadTokenStore,
  type DeletionRecords,
  type ThreadLookup,
} from "./thread-tokens.js";

type BbState = "live" | "archived" | "gone" | "unreachable";
const LATER_MS = 30_000;
type Lifetime = "durable" | "process";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

const route = {
  hostId: "host-one",
  threadId: "thr_suspend",
  provider: "claude" as const,
  accountId: null,
};
const nestedRoute = { hostId: route.hostId, threadId: route.threadId };

type SharedHosts = { root: string; hosts: HubTokenStore; hostToken: string };

async function sharedHosts(): Promise<SharedHosts> {
  const root = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const directory = await fs.mkdtemp(path.join(root, "bb-thread-hosts-"));
  directories.push(directory);
  const hosts = new HubTokenStore(directory, () => 1_000_000);
  await hosts.initialize();
  return { root, hosts, hostToken: await hosts.forHost(route.hostId) };
}

async function world(shared: SharedHosts | null = null) {
  const directory = await fs.mkdtemp(
    path.join(shared?.root ?? tmpdir(), "bb-thread-suspend-"),
  );
  directories.push(directory);
  let now = 1_000_000;
  let bb: BbState = "live";
  let lookups = 0;
  let gate: Promise<void> | null = null;
  const clock = () => now;
  const lookup: ThreadLookup = async () => {
    lookups += 1;
    if (gate !== null) await gate;
    if (bb === "unreachable") throw new Error("bb unreachable");
    return bb;
  };
  const hosts = shared?.hosts ?? new HubTokenStore(directory, clock);
  if (shared === null) await hosts.initialize();
  const hostToken = shared?.hostToken ?? (await hosts.forHost(route.hostId));
  const kv = memoryKv();
  const open = async () => {
    const store = new ThreadTokenStore(
      directory,
      hosts,
      clock,
      lookup,
      undefined,
      undefined,
      kv,
    );
    await store.initialize([route.hostId]);
    await store.sweepThreads(lookup);
    return store;
  };
  return {
    directory,
    kv,
    hosts,
    clock,
    hostToken,
    open,
    lookup,
    setBb: (state: BbState) => {
      bb = state;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    lookups: () => lookups,
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

async function mint(
  store: ThreadTokenStore,
  hostToken: string,
  lifetime: Lifetime,
) {
  return {
    token: await store.forThread(route, hostToken, lifetime),
    nested: await store.forNested(nestedRoute, hostToken, lifetime),
  };
}

async function accepted(
  store: ThreadTokenStore,
  tokens: { token: string; nested: string },
) {
  return {
    token: (await store.authenticate(tokens.token)) !== null,
    nested: (await store.authenticateNested(tokens.nested)) !== null,
  };
}

function refuseArchiveMarkers(): void {
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (
      String(file).includes("archived-thread-") ||
      String(file).includes("archive-revocation-")
    )
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return originalOpen(file, flags, mode);
  });
}

function refuseWrites(fragments: readonly string[]): void {
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (fragments.some((fragment) => String(file).includes(fragment)))
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return originalOpen(file, flags, mode);
  });
}

function memoryKv(): DeletionRecords & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    set: async (key, value) => {
      rows.set(key, value);
    },
    list: async (prefix) =>
      [...rows.keys()].filter(
        (key) => prefix === undefined || key.startsWith(prefix),
      ),
  };
}

function refuseKv(kv: DeletionRecords): void {
  vi.spyOn(kv, "set").mockRejectedValue(
    Object.assign(new Error("SQLITE_FULL"), { code: "SQLITE_FULL" }),
  );
}

function refuseMutations(kv: DeletionRecords): void {
  const refuse = () => {
    throw Object.assign(new Error("EROFS"), { code: "EROFS" });
  };
  refuseKv(kv);
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (flags !== undefined && flags !== "r") refuse();
    return originalOpen(file, flags, mode);
  });
  for (const method of [
    "rename",
    "rm",
    "unlink",
    "writeFile",
    "mkdir",
    "chmod",
  ] as const)
    vi.spyOn(fs, method).mockImplementation((async () => refuse()) as never);
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await fs.readdir(directory)).sort())
    files[name] = await fs.readFile(path.join(directory, name), "utf8");
  return files;
}

const DELETION_WRITES: readonly string[] = [
  "deleted-thread-",
  "archived-thread-",
  "archive-revocation-",
];

function refuseRecords(kv: DeletionRecords): void {
  refuseKv(kv);
  refuseWrites(DELETION_WRITES);
  const originalMkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, "mkdir").mockImplementation((async (
    file: unknown,
    options: unknown,
  ) => {
    if (String(file).includes("deleted-thread-"))
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return originalMkdir(file as never, options as never);
  }) as never);
}

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
  directory: string;
  kv: ReturnType<typeof memoryKv>;
  violations: string[];
  unsynced: Set<string>;
  undurable: { from: string | null; to: string; previous: string | null }[];
};

function watching(w: {
  directory: string;
  kv: ReturnType<typeof memoryKv>;
}): Watch {
  return {
    directory: w.directory,
    kv: w.kv,
    violations: [],
    unsynced: new Set(),
    undurable: [],
  };
}

const THREAD_DIGEST = createHash("sha256").update(route.threadId).digest("hex");
const CREDENTIAL_NAME =
  /^(?:suspended-)?(?:scoped-route-|scoped-process-route-|thread-route-|scoped-nested-route-|scoped-process-nested-route-|nested-route-)/u;

function isCredential(name: string): boolean {
  return CREDENTIAL_NAME.test(name) && name.includes(route.threadId);
}

function durableRecords(watch: Watch): { other: boolean; pending: boolean } {
  const names = readdirSync(watch.directory);
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
        (!digest || value.threadDigest === THREAD_DIGEST)
      );
    } catch {
      return false;
    }
  };
  return {
    other:
      watch.kv.rows.has(`deleted-thread:${THREAD_DIGEST}`) ||
      deletedMarker(`deleted-thread-${THREAD_DIGEST}.json`, true) ||
      durable(`deleted-thread-${THREAD_DIGEST}.d`) ||
      deletedMarker(`archived-thread-${THREAD_DIGEST}.json`, false) ||
      deletedMarker(`archive-revocation-${THREAD_DIGEST}.json`, false),
    pending: names.some(
      (name) =>
        name.startsWith(`deleted-pending-${THREAD_DIGEST}-`) && durable(name),
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

function checkRemoval(
  watch: Watch,
  method: string,
  args: readonly unknown[],
): void {
  const source = String(args[0]);
  if (!["rm", "unlink", "rename"].includes(method) || !existsSync(source))
    return;
  const name = path.basename(source);
  const target = method === "rename" ? path.basename(String(args[1])) : null;
  const removesPending = name.startsWith("deleted-pending-");
  const removesCredential =
    isCredential(name) &&
    (target === null ||
      (!CREDENTIAL_NAME.test(target) &&
        !target.startsWith("deleted-pending-")));
  if (!removesPending && !removesCredential) return;
  const records = durableRecords(watch);
  if (removesPending ? records.other : records.other || records.pending) return;
  watch.violations.push(
    `${method} ${name}${target === null ? "" : ` -> ${target}`} while no ${removesPending ? "other " : ""}deletion record was durable`,
  );
}

function injectFaults(
  faults: ReadonlySet<FaultClass>,
  crashAfter = Number.POSITIVE_INFINITY,
  watch: Watch | null = null,
  point: ContentPoint = "open",
): Mutation[] {
  const mutations: Mutation[] = [];
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
    if (mutations.length > crashAfter)
      throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    if (fault !== null && faults.has(fault)) {
      mutation.refused = true;
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    if (watch !== null) checkRemoval(watch, method, args);
    const result = await run();
    mutation.ok = true;
    return result;
  };
  const watched = (file: unknown) =>
    watch !== null &&
    path.dirname(path.resolve(String(file))) === path.resolve(watch.directory);
  const isRecord = (file: unknown) =>
    DELETION_WRITES.some((fragment) =>
      path.basename(String(file)).startsWith(fragment),
    );
  const contentFault = (file: unknown, at: ContentPoint) =>
    isRecord(file) && point === at ? "content" : null;
  if (watch !== null) {
    const originalSet = watch.kv.set.bind(watch.kv);
    vi.spyOn(watch.kv, "set").mockImplementation(async (key, value) =>
      attempt("kv", key, "kv", () => originalSet(key, value)),
    );
  }
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
          if (watched(file)) watch?.unsynced.add(name);
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
            if (watch === null) return;
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
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (flags === undefined || flags === "r")
      return handled(file, await originalOpen(file, flags, mode), false);
    const existed = existsSync(String(file));
    return attempt("open", file, contentFault(file, "open"), async () => {
      const handle = await originalOpen(file, flags, mode);
      if (watch !== null && watched(file)) {
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
  const track = (method: string, args: readonly unknown[]) => {
    if (watch === null || !watched(args[0])) return;
    const name = path.basename(String(args[0]));
    if (method === "rm" || method === "unlink") watch.unsynced.delete(name);
  };
  for (const [method, fault] of [
    ["rename", "rename"],
    ["rm", "rm"],
    ["unlink", "rm"],
    ["mkdir", "mkdir"],
    ["chmod", null],
  ] as const) {
    const original = (
      fs[method] as (...args: unknown[]) => Promise<unknown>
    ).bind(fs);
    vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) =>
      attempt(
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
          track(method, args);
          if (watch !== null && watched(target)) {
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
      )) as never);
  }
  return mutations;
}

async function deletionOutcome(
  lifetime: Lifetime,
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
  files: 1 | 2,
  crash: { during: "delete" | "restart"; after: number } | null,
  shared: SharedHosts,
) {
  injectFaults(new Set());
  const w = await world(shared);
  const watch = watching(w);
  const store = await w.open();
  const token = await store.forThread(route, w.hostToken, lifetime);
  const nested =
    files === 2
      ? await store.forNested(nestedRoute, w.hostToken, lifetime)
      : null;
  vi.restoreAllMocks();
  w.setBb("gone");
  const deleteMutations = injectFaults(
    faults,
    crash?.during === "delete" ? crash.after : undefined,
    watch,
    point,
  );
  await store.removeThread(route.threadId).catch(() => undefined);
  vi.restoreAllMocks();
  const durable = durableRecords(watch);
  losePower(watch);
  injectFaults(new Set(), undefined, watch);
  const first = new ThreadTokenStore(
    w.directory,
    w.hosts,
    w.clock,
    w.lookup,
    undefined,
    undefined,
    w.kv,
  );
  await first.initialize([route.hostId]);
  const firstMint =
    (await first.forThread(route, w.hostToken, lifetime).then(
      () => true,
      () => false,
    )) ||
    (await first.forNested(nestedRoute, w.hostToken, lifetime).then(
      () => true,
      () => false,
    ));
  const firstToken =
    (await first.authenticate(token)) !== null ||
    (nested !== null && (await first.authenticateNested(nested)) !== null);
  vi.restoreAllMocks();
  losePower(watch);
  if (crash?.during === "restart") {
    injectFaults(new Set(), crash.after, watch);
    await w.open().catch(() => undefined);
    vi.restoreAllMocks();
    losePower(watch);
  }
  const restartMutations = injectFaults(new Set(), undefined, watch);
  const restarted = await w.open();
  vi.restoreAllMocks();
  injectFaults(new Set());
  const oldTokenAccepted =
    (await restarted.authenticate(token)) !== null ||
    (nested !== null && (await restarted.authenticateNested(nested)) !== null);
  const mint =
    (await restarted.forThread(route, w.hostToken, lifetime).then(
      () => true,
      () => false,
    )) ||
    (await restarted.forNested(nestedRoute, w.hostToken, lifetime).then(
      () => true,
      () => false,
    ));
  vi.restoreAllMocks();
  await fs.rm(w.directory, { recursive: true, force: true });
  return {
    outcome: { token: firstToken || oldTokenAccepted, mint: firstMint || mint },
    recorded: durable.other || durable.pending,
    kvRefused: deleteMutations.some(
      (mutation) => mutation.method === "kv" && mutation.refused,
    ),
    deleteMutations,
    restartMutations,
    violations: watch.violations,
  };
}

const NO_RECORD: readonly FaultClass[] = ["kv", "content", "rename", "mkdir"];

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

function residualRow(
  files: 1 | 2,
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
  recorded: boolean,
  outcome: { token: boolean; mint: boolean },
): string {
  const yes = (value: boolean) => (value ? "yes" : "no");
  return `${files} file${files === 1 ? "" : "s"} | refused: ${faultLabel(faults, point)} | durable record: ${yes(recorded)} | old token accepted: ${yes(outcome.token)} | mint succeeds: ${yes(outcome.mint)}`;
}

const EXPECTED_RESIDUAL = [
  "1 file | refused: none | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rename | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rm | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rename+rm | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@open+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@write+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@sync+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content@dirsync+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@open+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@write+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@sync+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "1 file | refused: kv+content@dirsync+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: none | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rename | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rename | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rm | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rename+rm | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rename+rm | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rename+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rename+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@open+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@write+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@sync+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content@dirsync+rename+rm+mkdir | durable record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@open+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@write+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@sync+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
  "2 files | refused: kv+content@dirsync+rename+rm+mkdir | durable record: no | old token accepted: no | mint succeeds: no",
];

function crashAfter(
  mutations: number,
  refuseMarkers = false,
): { crashed: () => boolean } {
  let count = 0;
  let crashed = false;
  const fail = () => {
    count += 1;
    if (count > mutations) {
      crashed = true;
      throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    }
  };
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (
      refuseMarkers &&
      (String(file).includes("archived-thread-") ||
        String(file).includes("archive-revocation-"))
    )
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    if (flags !== undefined && flags !== "r") fail();
    return originalOpen(file, flags, mode);
  });
  for (const method of ["rename", "rm", "unlink", "writeFile"] as const) {
    const original = (
      fs[method] as (...args: unknown[]) => Promise<unknown>
    ).bind(fs);
    vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
      fail();
      return original(...args);
    }) as never);
  }
  return { crashed: () => crashed };
}

const PAUSED_FS_METHODS = [
  "readdir",
  "readFile",
  "open",
  "rename",
  "rm",
  "writeFile",
  "mkdir",
  "chmod",
] as const;

function pauseAt(
  point: number,
  only: (method: string) => boolean = () => true,
) {
  let count = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reach = () => {};
  const paused = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const step = async () => {
    count += 1;
    if (count !== point) return;
    reach();
    await gate;
  };
  for (const method of PAUSED_FS_METHODS) {
    const original = (
      fs[method] as (...args: unknown[]) => Promise<unknown>
    ).bind(fs);
    vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
      if (only(method)) await step();
      return original(...args);
    }) as never);
  }
  return {
    step,
    paused,
    release: () => {
      vi.restoreAllMocks();
      open();
    },
  };
}

async function expectNoMint(
  store: ThreadTokenStore,
  hostToken: string,
  lifetime: Lifetime,
): Promise<void> {
  await expect(store.forThread(route, hostToken, lifetime)).rejects.toThrow(
    "Cannot mint a credential for a deleted thread.",
  );
  await expect(
    store.forNested(nestedRoute, hostToken, lifetime),
  ).rejects.toThrow("Cannot mint a credential for a deleted thread.");
}

async function deletedMarkers(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) =>
    /^deleted-thread-[a-f0-9]{64}\.json$/u.test(name),
  );
}

const unarchive = (store: ThreadTokenStore) =>
  store.unarchiveThread(route.threadId);

type Transition = "restore" | "suspend" | "remove" | "admit";
type ThreadEvent = "archived" | "unarchived" | "deleted";

async function threadFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory))
    .filter((name) => name.includes(route.threadId))
    .map((name) =>
      name
        .replace(/^deleted-pending-[a-f0-9]{64}-/u, "")
        .replace(/^suspended-/u, ""),
    )
    .sort();
}

async function interleave(
  lifetime: Lifetime,
  transition: Transition,
  event: ThreadEvent,
  point: number,
): Promise<boolean> {
  const w = await world();
  let step = async () => {};
  const lookup: ThreadLookup = async (threadId, signal) => {
    await step();
    return w.lookup(threadId, signal);
  };
  const store = new ThreadTokenStore(w.directory, w.hosts, w.clock, lookup);
  await store.initialize([route.hostId]);
  const tokens = await mint(store, w.hostToken, lifetime);
  const stored = await threadFiles(w.directory);
  if (transition === "restore" || transition === "admit") {
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    w.setBb("live");
  } else {
    w.setBb(transition === "suspend" ? "archived" : "gone");
  }
  const pause = pauseAt(point);
  step = pause.step;
  let inFlight: { token: boolean; nested: boolean } | null = null;
  const done = { token: false, nested: false };
  const run = (async () => {
    if (transition === "restore")
      await store.restoreThread(
        route.threadId,
        store.archiveVersion(route.threadId),
      );
    else if (transition === "suspend")
      await store.suspendThread(route.threadId);
    else if (transition === "remove") await store.removeThread(route.threadId);
    else {
      const [token, nested] = await Promise.all([
        store.authenticate(tokens.token).finally(() => {
          done.token = true;
        }),
        store.authenticateNested(tokens.nested).finally(() => {
          done.nested = true;
        }),
      ]);
      inFlight = { token: token !== null, nested: nested !== null };
    }
  })();
  const reached = await Promise.race([
    pause.paused.then(() => true),
    run.then(() => false),
  ]);
  if (!reached) {
    pause.release();
    return false;
  }
  const final =
    transition === "remove" || event === "deleted"
      ? "gone"
      : event === "archived"
        ? "archived"
        : "live";
  w.setBb(final);
  const before = { ...done };
  const delivered =
    event === "archived"
      ? store.suspendThread(route.threadId)
      : event === "deleted"
        ? store.removeThread(route.threadId)
        : unarchive(store);
  step = async () => {};
  pause.release();
  await run;
  await delivered;
  const both = (value: boolean) => ({ token: value, nested: value });
  const at = `${transition} paused at point ${point}, then ${event}`;
  if (inFlight !== null)
    expect(inFlight, `${at}: in flight`).toEqual({
      token: before.token || final === "live",
      nested: before.nested || final === "live",
    });
  expect(await accepted(store, tokens), `${at}: next request`).toEqual(
    both(final === "live"),
  );
  if (final === "archived") {
    expect(await threadFiles(w.directory), `${at}: files`).toEqual(stored);
    w.setBb("live");
    expect(await accepted(store, tokens), `${at}: once live`).toEqual(
      both(true),
    );
  }
  if (final === "gone") {
    expect(await threadFiles(w.directory), `${at}: files`).toEqual([]);
    w.setBb("live");
    expect(await store.settleThread(route.threadId), `${at}: settle`).toBe(
      false,
    );
    await expectNoMint(store, w.hostToken, lifetime);
  }
  return true;
}

function holdOneLookup(answer: ThreadLookup) {
  let armed = false;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reach = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const lookup: ThreadLookup = async (threadId, signal) => {
    if (!armed) return answer(threadId, signal);
    armed = false;
    const captured = await answer(threadId, signal);
    reach();
    await gate;
    return captured;
  };
  return {
    lookup,
    reached,
    arm: () => {
      armed = true;
    },
    release: () => open(),
  };
}

type Answer = "live" | "archived" | "gone";

async function staleAnswer(
  lifetime: Lifetime,
  source: "admit" | "sweep",
  answer: Answer,
  event: ThreadEvent,
): Promise<void> {
  const w = await world();
  const held = holdOneLookup(w.lookup);
  const lookup = held.lookup;
  const store = new ThreadTokenStore(
    w.directory,
    w.hosts,
    w.clock,
    lookup,
    60_000,
  );
  await store.initialize([route.hostId]);
  const tokens = await mint(store, w.hostToken, lifetime);
  const stored = await threadFiles(w.directory);
  if (answer === "archived") {
    w.setBb("archived");
    await store.suspendThread(route.threadId);
  }
  if (answer === "gone") w.setBb("gone");
  held.arm();
  const run =
    source === "admit"
      ? Promise.all([
          store.authenticate(tokens.token),
          store.authenticateNested(tokens.nested),
        ]).then(([token, nested]) => ({
          token: token !== null,
          nested: nested !== null,
        }))
      : store.sweepThreads(lookup).then(() => null);
  await held.reached;
  const final =
    event === "archived"
      ? "archived"
      : event === "unarchived"
        ? "live"
        : "gone";
  w.setBb(final);
  if (event === "archived") await store.suspendThread(route.threadId);
  else if (event === "deleted") await store.removeThread(route.threadId);
  else expect(await unarchive(store)).toBe(true);
  held.release();
  const inFlight = await run;
  const both = (value: boolean) => ({ token: value, nested: value });
  const at = `${source} holding a stale ${answer} answer, then ${event}`;
  if (inFlight !== null)
    expect(inFlight, `${at}: in flight`).toEqual(both(final === "live"));
  expect(await accepted(store, tokens), `${at}: next request`).toEqual(
    both(final === "live"),
  );
  const local = new ThreadTokenStore(w.directory, w.hosts, w.clock);
  await local.initialize([route.hostId]);
  expect(await accepted(local, tokens), `${at}: on-disk state`).toEqual(
    both(final === "live"),
  );
  if (final === "gone") {
    expect(await threadFiles(w.directory), `${at}: files`).toEqual([]);
    w.setBb("live");
    expect(await store.settleThread(route.threadId), `${at}: settle`).toBe(
      false,
    );
    await expectNoMint(store, w.hostToken, lifetime);
    return;
  }
  expect(await threadFiles(w.directory), `${at}: files`).toEqual(stored);
  if (final === "archived") {
    w.setBb("live");
    expect(await accepted(store, tokens), `${at}: once live`).toEqual(
      both(true),
    );
  }
}

describe.each(["durable", "process"] as const)("%s credentials", (lifetime) => {
  it("accepts the same tokens after unarchive, in process and across a restart", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    const whileArchived = await w.open();
    expect(await accepted(whileArchived, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    await store.restoreThread(
      route.threadId,
      store.archiveVersion(route.threadId),
    );
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    expect(await store.forThread(route, w.hostToken, lifetime)).toBe(
      tokens.token,
    );
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("accepts the tokens again on the next request after a missed unarchive event once bb reports the thread live", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("asks bb on every authentication, sharing one in-flight lookup between concurrent ones", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const before = w.lookups();
    const release = w.hold();
    const attempts = Array.from({ length: 8 }, (_, index) =>
      index % 2 === 0
        ? store.authenticate(tokens.token)
        : store.authenticateNested(tokens.nested),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.lookups()).toBe(before + 1);
    release();
    expect((await Promise.all(attempts)).every((value) => value !== null)).toBe(
      true,
    );
    expect(w.lookups()).toBe(before + 1);
    expect(await store.authenticate(tokens.token)).not.toBeNull();
    expect(w.lookups()).toBe(before + 2);
  });

  it("rejects at once when bb archives a confirmed thread without delivering the event, and accepts the same tokens when bb reports it live", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    w.setBb("archived");
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(
      (await fs.readdir(w.directory)).filter((name) =>
        name.includes(route.threadId),
      ),
    ).toHaveLength(2);
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("rejects without deleting or suspending anything while bb cannot answer, even for a thread bb confirmed live, and accepts the same tokens once it answers", async () => {
    const w = await world();
    const warnings: string[] = [];
    const store = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      w.lookup,
      5_000,
      (message) => warnings.push(message),
    );
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    const stored = (await fs.readdir(w.directory)).filter((name) =>
      name.includes(route.threadId),
    );
    w.setBb("archived");
    w.setBb("unreachable");
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(
      (await fs.readdir(w.directory)).filter((name) =>
        name.includes(route.threadId),
      ),
    ).toEqual(stored);
    expect(warnings).toEqual([
      `Account Pooler rejected a token for thread ${route.threadId}: bb's thread lookup failed, so the thread could not be confirmed live.`,
    ]);
    w.advance(LATER_MS * 2);
    expect(await store.authenticate(tokens.token)).toBeNull();
    expect(warnings).toHaveLength(2);
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("rejects and names the timeout when bb's lookup hangs, without retrying it", async () => {
    const w = await world();
    let calls = 0;
    const answer = { hang: false };
    const hanging: ThreadLookup = (threadId, signal) => {
      calls += 1;
      return answer.hang
        ? new Promise(() => undefined)
        : w.lookup(threadId, signal);
    };
    const warnings: string[] = [];
    const store = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      hanging,
      20,
      (message) => warnings.push(message),
    );
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
    answer.hang = true;
    calls = 0;
    expect(await store.authenticate(tokens.token)).toBeNull();
    expect(calls).toBe(1);
    expect(warnings).toEqual([
      `Account Pooler rejected a token for thread ${route.threadId}: bb's thread lookup timed out, so the thread could not be confirmed live.`,
    ]);
  });

  it("retries a failed lookup once within the same flight", async () => {
    const w = await world();
    let calls = 0;
    let failNext = false;
    const flaky: ThreadLookup = async () => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
      return "live";
    };
    const store = new ThreadTokenStore(w.directory, w.hosts, w.clock, flaky);
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
    calls = 0;
    failNext = true;
    expect(await store.authenticate(tokens.token)).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("revokes for good on delete, even when bb later reports the thread live", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("gone");
    await store.removeThread(route.threadId);
    w.setBb("live");
    await store.restoreThread(
      route.threadId,
      store.archiveVersion(route.threadId),
    );
    w.advance(LATER_MS);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
  });

  it("renames the files aside, never deleting them, when no archive marker can be written", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const before = (await fs.readdir(w.directory))
      .filter((name) => name.includes(route.threadId))
      .sort();
    const contents = await Promise.all(
      before.map((name) => fs.readFile(path.join(w.directory, name), "utf8")),
    );
    w.setBb("archived");
    refuseArchiveMarkers();
    await expect(store.suspendThread(route.threadId)).rejects.toThrow("ENOSPC");
    vi.restoreAllMocks();
    const aside = (await fs.readdir(w.directory))
      .filter((name) => name.includes(route.threadId))
      .sort();
    expect(aside).toEqual(before.map((name) => `suspended-${name}`));
    expect(
      await Promise.all(
        aside.map((name) => fs.readFile(path.join(w.directory, name), "utf8")),
      ),
    ).toEqual(contents);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    const offline = new ThreadTokenStore(w.directory, w.hosts, w.clock);
    await offline.initialize([route.hostId]);
    expect(await accepted(offline, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
    expect(
      (await fs.readdir(w.directory))
        .filter((name) => name.includes(route.threadId))
        .sort(),
    ).toEqual(before);
  });

  it("keeps the files and the suspension when the marker writes and the renames all fail, and accepts nothing until bb answers", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    refuseArchiveMarkers();
    vi.spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("EROFS"), { code: "EROFS" }),
    );
    await expect(store.suspendThread(route.threadId)).rejects.toThrow("ENOSPC");
    vi.restoreAllMocks();
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("unreachable");
    const unreachable = await w.open();
    expect(await accepted(unreachable, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("archived");
    expect(await accepted(unreachable, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    w.advance(LATER_MS);
    expect(await accepted(unreachable, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("accepts the tokens after unarchive when renaming the suspended files back fails, and again after a restart", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    refuseArchiveMarkers();
    await expect(store.suspendThread(route.threadId)).rejects.toThrow("ENOSPC");
    vi.restoreAllMocks();
    w.setBb("live");
    refuseArchiveMarkers();
    vi.spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("EIO"), { code: "EIO" }),
    );
    await store.restoreThread(
      route.threadId,
      store.archiveVersion(route.threadId),
    );
    vi.restoreAllMocks();
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    w.setBb("unreachable");
    const unreachable = await w.open();
    expect(await accepted(unreachable, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("keeps every token after a crash at any point of an archive whose marker cannot be written", async () => {
    let completed = false;
    let mutations = 0;
    for (; !completed; mutations += 1) {
      expect(mutations).toBeLessThan(50);
      const w = await world();
      const store = await w.open();
      const tokens = await mint(store, w.hostToken, lifetime);
      w.setBb("archived");
      const crash = crashAfter(mutations, true);
      await store.suspendThread(route.threadId).catch(() => undefined);
      vi.restoreAllMocks();
      completed = !crash.crashed();
      w.setBb("unreachable");
      const unreachable = await w.open();
      expect(await accepted(unreachable, tokens)).toEqual({
        token: false,
        nested: false,
      });
      w.setBb("live");
      w.advance(LATER_MS);
      expect(await accepted(unreachable, tokens)).toEqual({
        token: true,
        nested: true,
      });
      const again = await w.open();
      expect(await accepted(again, tokens)).toEqual({
        token: true,
        nested: true,
      });
    }
    expect(mutations).toBeGreaterThan(1);
  });

  it("rejects the tokens of a thread bb archived while the store missed the event", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.setBb("live");
    w.advance(LATER_MS);
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  for (const operation of ["archive", "unarchive"] as const) {
    it(`keeps every token restorable and never accepts one while archived after a crash at any point of ${operation}`, async () => {
      let completed = false;
      let mutations = 0;
      for (; !completed; mutations += 1) {
        expect(mutations).toBeLessThan(50);
        const w = await world();
        const store = await w.open();
        const tokens = await mint(store, w.hostToken, lifetime);
        if (operation === "unarchive") {
          w.setBb("archived");
          await store.suspendThread(route.threadId);
        }
        w.setBb(operation === "archive" ? "archived" : "live");
        const crash = crashAfter(mutations);
        try {
          if (operation === "archive")
            await store.suspendThread(route.threadId);
          else
            await store.restoreThread(
              route.threadId,
              store.archiveVersion(route.threadId),
            );
        } catch {}
        vi.restoreAllMocks();
        completed = !crash.crashed();
        const restarted = await w.open();
        if (operation === "archive") {
          expect(await accepted(restarted, tokens)).toEqual({
            token: false,
            nested: false,
          });
          w.setBb("live");
          await restarted.restoreThread(
            route.threadId,
            restarted.archiveVersion(route.threadId),
          );
        }
        expect(await accepted(restarted, tokens)).toEqual({
          token: true,
          nested: true,
        });
        const again = await w.open();
        expect(await accepted(again, tokens)).toEqual({
          token: true,
          nested: true,
        });
      }
      expect(mutations).toBeGreaterThan(1);
    });
  }
  it("rejects both token paths when thread.archived arrives while restore is paused after its version check, and keeps the credentials", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const stored = await threadFiles(w.directory);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    w.setBb("live");
    const pause = pauseAt(1, (method) => method === "readdir");
    const inFlight = Promise.all([
      store.authenticate(tokens.token),
      store.authenticateNested(tokens.nested),
    ]);
    await pause.paused;
    w.setBb("archived");
    const archived = store.suspendThread(route.threadId);
    pause.release();
    expect(await inFlight).toEqual([null, null]);
    await archived;
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await threadFiles(w.directory)).toEqual(stored);
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it.each(["restore", "suspend", "remove", "admit"] as const)(
    "ends in the state of the last event when archive, unarchive or delete arrives at any pause of %s",
    async (transition) => {
      let deepest = 0;
      for (const event of ["archived", "unarchived", "deleted"] as const) {
        let point = 1;
        while (await interleave(lifetime, transition, event, point)) {
          deepest = Math.max(deepest, point);
          point += 1;
        }
      }
      expect(deepest).toBeGreaterThan(1);
    },
    120_000,
  );
  it("keeps the same tokens accepted when a lookup that saw the thread archived returns after the thread was unarchived", async () => {
    const w = await world();
    const held = holdOneLookup(w.lookup);
    const store = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      held.lookup,
      60_000,
    );
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
    const stored = await threadFiles(w.directory);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    held.arm();
    const inFlight = store.authenticate(tokens.token);
    await held.reached;
    w.setBb("live");
    expect(await unarchive(store)).toBe(true);
    expect(await store.authenticateNested(tokens.nested)).not.toBeNull();
    held.release();
    expect(await inFlight).not.toBeNull();
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    expect(await threadFiles(w.directory)).toEqual(stored);
    const local = new ThreadTokenStore(w.directory, w.hosts, w.clock);
    await local.initialize([route.hostId]);
    expect(await accepted(local, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it.each(
    (["admit", "sweep"] as const).flatMap((source) =>
      (["live", "archived", "gone"] as const).map(
        (answer) => [source, answer] as const,
      ),
    ),
  )(
    "drops a stale %s lookup answer of %s when archive, unarchive or delete completes while it is held",
    async (source, answer) => {
      for (const event of ["archived", "unarchived", "deleted"] as const)
        await staleAnswer(lifetime, source, answer, event);
    },
    60_000,
  );
  it("keeps a deleted thread deleted when bb answers live afterwards, stale or fresh: old tokens are rejected and nothing can be minted, also after a restart", async () => {
    const w = await world();
    const held = holdOneLookup(w.lookup);
    const warnings: string[] = [];
    const store = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      held.lookup,
      60_000,
      (message) => warnings.push(message),
    );
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
    held.arm();
    const inFlight = store.authenticate(tokens.token);
    await held.reached;
    w.setBb("gone");
    await store.removeThread(route.threadId);
    w.setBb("live");
    held.release();
    expect(await inFlight).toBeNull();
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await store.settleThread(route.threadId)).toBe(false);
    expect(await unarchive(store)).toBe(false);
    expect(
      await store.restoreThread(
        route.threadId,
        store.archiveVersion(route.threadId),
      ),
    ).toBeNull();
    await store.sweepThreads(held.lookup);
    await expectNoMint(store, w.hostToken, lifetime);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(await deletedMarkers(w.directory)).toHaveLength(1);
    expect(warnings).toContain(
      `Account Pooler kept thread ${route.threadId} deleted: bb reported it live after it was deleted, and a deleted thread's credentials are never restored or minted again.`,
    );
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
    expect(await threadFiles(w.directory)).toEqual([]);
  });

  it("keeps a thread deleted after a restart whose first bb answer is live when its deleted marker could not be written", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    refuseWrites(["deleted-thread-"]);
    w.setBb("gone");
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    vi.restoreAllMocks();
    expect(await deletedMarkers(w.directory)).toEqual([]);
    w.setBb("live");
    const restarted = await w.open();
    const before = w.lookups();
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    expect(w.lookups()).toBe(before + 1);
    await expectNoMint(restarted, w.hostToken, lifetime);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(removal).toBe("recorded");
  });

  it("keeps every credential file as a pending deletion when no deletion record can be written, and finishes the delete after a restart whose bb answer is gone", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const stored = await threadFiles(w.directory);
    refuseRecords(w.kv);
    w.setBb("gone");
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    vi.restoreAllMocks();
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await store.settleThread(route.threadId)).toBe(false);
    await expectNoMint(store, w.hostToken, lifetime);
    const held = (await fs.readdir(w.directory)).filter((name) =>
      name.includes(route.threadId),
    );
    expect(held.every((name) => name.startsWith("deleted-pending-"))).toBe(
      true,
    );
    expect(await threadFiles(w.directory)).toEqual(stored);
    expect(await deletedMarkers(w.directory)).toEqual([]);
    expect(removal).toContain("could not record the deletion");
    w.setBb("gone");
    const restarted = await w.open();
    expect(await deletedMarkers(w.directory)).toHaveLength(1);
    expect(await threadFiles(w.directory)).toEqual([]);
    w.setBb("live");
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
  });

  it("keeps a thread deleted after restarts whose first bb answer is live when no deletion record can be written, and records the delete once a write succeeds", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const stored = await threadFiles(w.directory);
    refuseRecords(w.kv);
    w.setBb("gone");
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    expect(removal).toContain("could not record the deletion");
    w.setBb("live");
    const restarted = await w.open();
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await deletedMarkers(w.directory)).toEqual([]);
    const held = (await fs.readdir(w.directory)).filter((name) =>
      name.includes(route.threadId),
    );
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((name) => name.startsWith("deleted-pending-"))).toBe(
      true,
    );
    expect(await threadFiles(w.directory)).toEqual(stored);
    vi.restoreAllMocks();
    const recorded = await w.open();
    expect(await deletedMarkers(w.directory)).toHaveLength(1);
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(await recorded.settleThread(route.threadId)).toBe(false);
    await expectNoMint(recorded, w.hostToken, lifetime);
    expect(await accepted(recorded, tokens)).toEqual({
      token: false,
      nested: false,
    });
    const later = await w.open();
    expect(await later.settleThread(route.threadId)).toBe(false);
    await expectNoMint(later, w.hostToken, lifetime);
  });

  it("keeps a thread deleted in process and leaves the disk unchanged when every mutation in its directory is refused", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const before = await snapshot(w.directory);
    refuseMutations(w.kv);
    w.setBb("gone");
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    expect(removal).toContain("could not record the deletion");
    w.setBb("live");
    expect(await store.settleThread(route.threadId)).toBe(false);
    await expectNoMint(store, w.hostToken, lifetime);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(
      await store.restoreThread(
        route.threadId,
        store.archiveVersion(route.threadId),
      ),
    ).toBeNull();
    expect(await unarchive(store)).toBe(false);
    expect(await snapshot(w.directory)).toEqual(before);
  });

  it("keeps a deleted thread deleted after a restart whose first bb answer is live when every deletion-record write and the rename of its only credential file are refused, because the deletion directory records it", async () => {
    const w = await world();
    const store = await w.open();
    const token = await store.forThread(route, w.hostToken, lifetime);
    w.setBb("gone");
    injectFaults(new Set(["content", "rename"]));
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    vi.restoreAllMocks();
    w.setBb("live");
    const restarted = await w.open();
    expect(await restarted.authenticate(token)).toBeNull();
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(await deletedMarkers(w.directory)).toEqual([]);
    expect(
      (await fs.readdir(w.directory)).filter((name) =>
        /^deleted-thread-[a-f0-9]{64}\.d$/u.test(name),
      ),
    ).toHaveLength(1);
    expect(removal).toBe("recorded");
  });

  it("records the deletion in bb's database before removing any file when content writes, renames and the deletion directory are refused but rm works, and accepts no old token and mints nothing after a restart whose first bb answer is live", async () => {
    const w = await world();
    const watch = watching(w);
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("gone");
    const mutations = injectFaults(
      new Set(["content", "rename", "mkdir"]),
      undefined,
      watch,
    );
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    vi.restoreAllMocks();
    const kvRecord = mutations.findIndex(
      (mutation) => mutation.method === "kv" && mutation.ok,
    );
    const firstRemoval = mutations.findIndex(
      (mutation) =>
        (mutation.method === "rm" || mutation.method === "unlink") &&
        mutation.ok &&
        isCredential(mutation.target),
    );
    expect(removal).toBe("recorded");
    expect(kvRecord).toBeGreaterThanOrEqual(0);
    expect(firstRemoval).toBeGreaterThan(kvRecord);
    expect(w.kv.rows.get(`deleted-thread:${THREAD_DIGEST}`)).toEqual({
      deletedAt: w.clock(),
    });
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(await deletedMarkers(w.directory)).toEqual([]);
    expect(watch.violations).toEqual([]);
    w.setBb("live");
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
  });

  it("keeps the deleted-pending renames as the only record when bb's database, content writes and the deletion directory are refused, and accepts no old token and mints nothing after a restart whose first bb answer is live", async () => {
    const w = await world();
    const watch = watching(w);
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const stored = await threadFiles(w.directory);
    w.setBb("gone");
    injectFaults(new Set(["kv", "content", "mkdir"]), undefined, watch);
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    expect(removal).toContain("could not record the deletion");
    w.setBb("live");
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await restarted.settleThread(route.threadId)).toBe(false);
    await expectNoMint(restarted, w.hostToken, lifetime);
    await restarted.sweepThreads(w.lookup);
    vi.restoreAllMocks();
    const held = (await fs.readdir(w.directory)).filter((name) =>
      name.includes(route.threadId),
    );
    expect(held.length).toBe(stored.length);
    expect(held.every((name) => name.startsWith("deleted-pending-"))).toBe(
      true,
    );
    expect(await threadFiles(w.directory)).toEqual(stored);
    expect(w.kv.rows.size).toBe(0);
    expect(await deletedMarkers(w.directory)).toEqual([]);
    expect(watch.violations).toEqual([]);
  });

  it("removes nothing and keeps every file byte-identical when bb's database, content writes, renames and the deletion directory are all refused even though rm works, while the thread stays deleted in process", async () => {
    const w = await world();
    const watch = watching(w);
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const before = await snapshot(w.directory);
    w.setBb("gone");
    injectFaults(new Set(NO_RECORD), undefined, watch);
    const removal = await store.removeThread(route.threadId).then(
      () => "recorded",
      (error: unknown) => String(error),
    );
    expect(removal).toContain("could not record the deletion");
    w.setBb("live");
    await store.sweepThreads(w.lookup);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await store.settleThread(route.threadId)).toBe(false);
    await expectNoMint(store, w.hostToken, lifetime);
    vi.restoreAllMocks();
    expect(await snapshot(w.directory)).toEqual(before);
    expect(w.kv.rows.size).toBe(0);
    expect(watch.violations).toEqual([]);
  });

  it("retries an unrecorded deletion on the next sweep, recording it in bb's database before removing the deleted-pending files", async () => {
    const w = await world();
    const watch = watching(w);
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    refuseRecords(w.kv);
    w.setBb("gone");
    await expect(store.removeThread(route.threadId)).rejects.toThrow(
      "could not record the deletion",
    );
    vi.restoreAllMocks();
    expect(
      (await fs.readdir(w.directory))
        .filter((name) => name.includes(route.threadId))
        .every((name) => name.startsWith("deleted-pending-")),
    ).toBe(true);
    w.setBb("live");
    injectFaults(new Set(), undefined, watch);
    await store.sweepThreads(w.lookup);
    vi.restoreAllMocks();
    expect(w.kv.rows.has(`deleted-thread:${THREAD_DIGEST}`)).toBe(true);
    expect(
      (await fs.readdir(w.directory)).filter((name) =>
        name.includes(route.threadId),
      ),
    ).toEqual([]);
    expect(watch.violations).toEqual([]);
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    await expectNoMint(store, w.hostToken, lifetime);
  });

  it("rejects every token and refuses mints while bb's deletion records cannot be loaded at start, accepts a live thread's tokens once a sweep reloads them, and never reads them on authentication", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    const failing = vi
      .spyOn(w.kv, "list")
      .mockRejectedValue(new Error("SQLITE_BUSY"));
    const restarted = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      w.lookup,
      undefined,
      undefined,
      w.kv,
    );
    await restarted.initialize([route.hostId]);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    await expect(
      restarted.forThread(route, w.hostToken, lifetime),
    ).rejects.toThrow("before Account Pooler has loaded its deletion records");
    await restarted.sweepThreads(w.lookup);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    failing.mockRestore();
    await restarted.sweepThreads(w.lookup);
    const reads = vi.spyOn(w.kv, "list");
    const writes = vi.spyOn(w.kv, "set");
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it("removes the credentials of a thread deleted only in bb's database once a sweep reloads the deletion records that failed to load at start", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    await w.kv.set(`deleted-thread:${THREAD_DIGEST}`, { deletedAt: w.clock() });
    const failing = vi
      .spyOn(w.kv, "list")
      .mockRejectedValue(new Error("SQLITE_BUSY"));
    const restarted = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      w.lookup,
      undefined,
      undefined,
      w.kv,
    );
    await restarted.initialize([route.hostId]);
    expect(await threadFiles(w.directory)).not.toEqual([]);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    failing.mockRestore();
    await restarted.sweepThreads(w.lookup);
    expect(await threadFiles(w.directory)).toEqual([]);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    await expectNoMint(restarted, w.hostToken, lifetime);
  });

  it("asks bb before every mint: serves a thread bb reports live as before, refuses and suspends one bb reports archived, and refuses without changing anything while bb cannot answer", async () => {
    const w = await world();
    const store = await w.open();
    const before = w.lookups();
    const tokens = await mint(store, w.hostToken, lifetime);
    expect(w.lookups()).toBe(before + 2);
    expect(await mint(store, w.hostToken, lifetime)).toEqual(tokens);
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    const stored = await snapshot(w.directory);
    w.setBb("unreachable");
    await expect(store.forThread(route, w.hostToken, lifetime)).rejects.toThrow(
      "bb has not confirmed live",
    );
    await expect(
      store.forNested(nestedRoute, w.hostToken, lifetime),
    ).rejects.toThrow("bb has not confirmed live");
    expect(await snapshot(w.directory)).toEqual(stored);
    w.setBb("archived");
    await expect(store.forThread(route, w.hostToken, lifetime)).rejects.toThrow(
      "archived thread",
    );
    await expect(
      store.forNested(nestedRoute, w.hostToken, lifetime),
    ).rejects.toThrow("archived thread");
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(await threadFiles(w.directory)).not.toEqual([]);
    w.setBb("live");
    expect(await mint(store, w.hostToken, lifetime)).toEqual(tokens);
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
    w.setBb("gone");
    await expect(store.forThread(route, w.hostToken, lifetime)).rejects.toThrow(
      "deleted thread",
    );
    expect(await threadFiles(w.directory)).toEqual([]);
  });

  it("refuses a mint after a restart when bb committed the delete and no deletion record survived anywhere", async () => {
    const w = await world();
    const watch = watching(w);
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("gone");
    injectFaults(new Set(NO_RECORD), undefined, watch);
    await expect(store.removeThread(route.threadId)).rejects.toThrow(
      "could not record the deletion",
    );
    vi.restoreAllMocks();
    expect(durableRecords(watch)).toEqual({ other: false, pending: false });
    expect(w.kv.rows.size).toBe(0);
    const restarted = new ThreadTokenStore(
      w.directory,
      w.hosts,
      w.clock,
      w.lookup,
      undefined,
      undefined,
      w.kv,
    );
    await restarted.initialize([route.hostId]);
    await expectNoMint(restarted, w.hostToken, lifetime);
    expect(await accepted(restarted, tokens)).toEqual({
      token: false,
      nested: false,
    });
    expect(watch.violations).toEqual([]);
  });

  it.each([
    ["the write after open", "write", false],
    ["the write after open", "write", true],
    ["the file sync", "sync", false],
    ["the file sync", "sync", true],
    [
      "the directory sync after the in-place create and after mkdir",
      "dirsync",
      false,
    ],
    [
      "the directory sync after the in-place create and after mkdir",
      "dirsync",
      true,
    ],
  ] as const)(
    "counts no deletion record when %s fails on every record path (point %s, bb's database refused: %s), removes no credential before a durable record, and accepts no old token and mints nothing after restarts",
    async (_, point, kvRefused) => {
      const w = await world();
      const watch = watching(w);
      const store = await w.open();
      const tokens = await mint(store, w.hostToken, lifetime);
      const stored = await threadFiles(w.directory);
      const marker = path.join(
        w.directory,
        `deleted-thread-${THREAD_DIGEST}.json`,
      );
      w.setBb("gone");
      const faults = new Set<FaultClass>(["content"]);
      if (point !== "dirsync") faults.add("mkdir");
      if (kvRefused) faults.add("kv");
      injectFaults(faults, undefined, watch, point);
      const removal = await store.removeThread(route.threadId).then(
        () => "recorded",
        (error: unknown) => String(error),
      );
      vi.restoreAllMocks();
      expect(watch.violations).toEqual([]);
      if (kvRefused) {
        expect(removal).toContain("could not record the deletion");
        expect(durableRecords(watch)).toEqual({
          other: false,
          pending: point !== "dirsync",
        });
        expect(await threadFiles(w.directory)).toEqual(stored);
        expect(existsSync(marker)).toBe(true);
      } else {
        expect(removal).toBe("recorded");
        expect(await threadFiles(w.directory)).toEqual([]);
      }
      const powerLoss = !(kvRefused && point === "dirsync");
      if (powerLoss) losePower(watch);
      if (kvRefused && point !== "dirsync")
        expect(await fs.readFile(marker, "utf8")).toBe("");
      w.setBb(kvRefused ? "live" : "gone");
      injectFaults(new Set(["kv", "content", "mkdir"]), undefined, watch);
      const restarted = await w.open();
      expect(await accepted(restarted, tokens)).toEqual({
        token: false,
        nested: false,
      });
      await expectNoMint(restarted, w.hostToken, lifetime);
      vi.restoreAllMocks();
      expect(watch.violations).toEqual([]);
      if (kvRefused) {
        expect(await threadFiles(w.directory)).toEqual(
          point === "dirsync" ? [] : stored,
        );
        if (point !== "dirsync")
          expect(await fs.readFile(marker, "utf8")).toBe("");
      }
      w.setBb("live");
      injectFaults(new Set(), undefined, watch);
      const recovered = await w.open();
      expect(await accepted(recovered, tokens)).toEqual({
        token: false,
        nested: false,
      });
      expect(await recovered.settleThread(route.threadId)).toBe(false);
      await expectNoMint(recovered, w.hostToken, lifetime);
      vi.restoreAllMocks();
      expect(watch.violations).toEqual([]);
      expect(await threadFiles(w.directory)).toEqual([]);
      expect(durableRecords(watch).other).toBe(true);
    },
  );

  it("computes the deletion residual for every subset of refused bb-database, content, rename, rm and directory mutations, with content refused at its open, its write, its file sync or the directory sync, one and two credential files, and every crash point from the first mutation of the delete through the next start, losing every unsynced change at each restart, minting first on a start that has not swept yet, with bb answering gone after every restart because the delete is committed in bb's own thread row", async () => {
    const shared = await sharedHosts();
    const rows: string[] = [];
    const runs: number[] = [];
    const violations: string[] = [];
    const acceptedRuns: string[] = [];
    for (const files of [1, 2] as const)
      for (const faults of faultSubsets())
        for (const point of faults.has("content")
          ? CONTENT_POINTS
          : (["open"] as const)) {
          const cell = `${files} file${files === 1 ? "" : "s"} | refused: ${faultLabel(faults, point)}`;
          const outcomes: { token: boolean; mint: boolean }[] = [];
          const note = (
            at: string,
            run: Awaited<ReturnType<typeof deletionOutcome>>,
          ) => {
            violations.push(
              ...run.violations.map((v) => `${cell} ${at}: ${v}`),
            );
            outcomes.push(run.outcome);
            if (run.outcome.token || run.outcome.mint)
              acceptedRuns.push(
                `${cell} | ${at} | durable record before the crash: ${run.recorded ? "yes" : "no"} | kv write refused before the crash: ${run.kvRefused ? "yes" : "no"} | old token accepted: ${run.outcome.token ? "yes" : "no"} | mint succeeds: ${run.outcome.mint ? "yes" : "no"}`,
              );
          };
          const probe = await deletionOutcome(
            lifetime,
            faults,
            point,
            files,
            null,
            shared,
          );
          note("completed", probe);
          for (let after = 0; after < probe.deleteMutations.length; after += 1)
            note(
              `delete@${after}`,
              await deletionOutcome(
                lifetime,
                faults,
                point,
                files,
                { during: "delete", after },
                shared,
              ),
            );
          for (let after = 0; after < probe.restartMutations.length; after += 1)
            note(
              `restart@${after}`,
              await deletionOutcome(
                lifetime,
                faults,
                point,
                files,
                { during: "restart", after },
                shared,
              ),
            );
          rows.push(
            residualRow(files, faults, point, probe.recorded, {
              token: outcomes.some((outcome) => outcome.token),
              mint: outcomes.some((outcome) => outcome.mint),
            }),
          );
          runs.push(outcomes.length);
        }
    console.log(
      [
        `deletion residual (${lifetime}); every unsynced change is lost at each restart, the first start mints and authenticates before any sweep, and bb answers gone, as its committed deletedAt does:`,
        ...rows.map((row, index) => `${row} | runs: ${runs[index]}`),
        "",
        `runs that accepted an old token or minted (${acceptedRuns.length}):`,
        ...acceptedRuns,
      ].join("\n"),
    );
    expect(violations).toEqual([]);
    expect(rows).toEqual(EXPECTED_RESIDUAL);
    expect(runs.every((count) => count > 1)).toBe(true);
  }, 600_000);
});
