import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore, type ThreadLookup } from "./thread-tokens.js";

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

async function world() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bb-thread-suspend-"));
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
  const hosts = new HubTokenStore(directory, clock);
  await hosts.initialize();
  const hostToken = await hosts.forHost(route.hostId);
  const open = async () => {
    const store = new ThreadTokenStore(directory, hosts, clock, lookup);
    await store.initialize([route.hostId]);
    await store.sweepThreads(lookup);
    return store;
  };
  return {
    directory,
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

function refuseMutations(): void {
  const refuse = () => {
    throw Object.assign(new Error("EROFS"), { code: "EROFS" });
  };
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

function refuseRecords(): void {
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

type FaultClass = "content" | "rename" | "rm" | "mkdir";
const FAULT_CLASSES: readonly FaultClass[] = [
  "content",
  "rename",
  "rm",
  "mkdir",
];
type Mutation = { method: string; target: string; ok: boolean };

function injectFaults(
  faults: ReadonlySet<FaultClass>,
  crashAfter = Number.POSITIVE_INFINITY,
): Mutation[] {
  const mutations: Mutation[] = [];
  const attempt = async <T>(
    method: string,
    target: unknown,
    fault: FaultClass | null,
    run: () => Promise<T>,
  ): Promise<T> => {
    const mutation = {
      method,
      target: path.basename(String(target)),
      ok: false,
    };
    mutations.push(mutation);
    if (mutations.length > crashAfter)
      throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    if (fault !== null && faults.has(fault))
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const result = await run();
    mutation.ok = true;
    return result;
  };
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (flags === undefined || flags === "r")
      return originalOpen(file, flags, mode);
    const record = DELETION_WRITES.some((fragment) =>
      path.basename(String(file)).startsWith(fragment),
    );
    return attempt("open", file, record ? "content" : null, () =>
      originalOpen(file, flags, mode),
    );
  });
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
      attempt(method, method === "rename" ? args[1] : args[0], fault, () =>
        original(...args),
      )) as never);
  }
  return mutations;
}

function recordsDeletion(mutation: Mutation): boolean {
  if (!mutation.ok) return false;
  if (mutation.method === "open")
    return /^deleted-thread-[a-f0-9]{64}\.json$/u.test(mutation.target);
  if (mutation.method === "mkdir")
    return /^deleted-thread-[a-f0-9]{64}\.d$/u.test(mutation.target);
  if (mutation.method === "rename")
    return /^(?:deleted-thread-[a-f0-9]{64}\.json$|archived-thread-|archive-revocation-|deleted-pending-)/u.test(
      mutation.target,
    );
  return false;
}

async function deletionOutcome(
  lifetime: Lifetime,
  faults: ReadonlySet<FaultClass>,
  files: 1 | 2,
  crash: { during: "delete" | "restart"; after: number } | null,
) {
  const w = await world();
  const store = await w.open();
  const token = await store.forThread(route, w.hostToken, lifetime);
  const nested =
    files === 2
      ? await store.forNested(nestedRoute, w.hostToken, lifetime)
      : null;
  w.setBb("gone");
  const deleteMutations = injectFaults(
    faults,
    crash?.during === "delete" ? crash.after : undefined,
  );
  await store.removeThread(route.threadId).catch(() => undefined);
  vi.restoreAllMocks();
  w.setBb("live");
  if (crash?.during === "restart") {
    injectFaults(new Set(), crash.after);
    await w.open().catch(() => undefined);
    vi.restoreAllMocks();
  }
  const restartMutations = crash === null ? injectFaults(new Set()) : [];
  const restarted = await w.open();
  vi.restoreAllMocks();
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
  return {
    outcome: { token: oldTokenAccepted, mint },
    deleteMutations,
    restartMutations,
  };
}

const EXPECTED_RESIDUAL = [
  "1 file | refused: none | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rename | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: rm | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rm | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+rm | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rename+rm | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rename+mkdir | record: no | old token accepted: no | mint succeeds: yes",
  "1 file | refused: rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: rename+rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "1 file | refused: content+rename+rm+mkdir | record: no | old token accepted: yes | mint succeeds: yes",
  "2 files | refused: none | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rename | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: rm | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rm | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+rm | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rename+rm | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rename+mkdir | record: no | old token accepted: no | mint succeeds: yes",
  "2 files | refused: rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: rename+rm+mkdir | record: yes | old token accepted: no | mint succeeds: no",
  "2 files | refused: content+rename+rm+mkdir | record: no | old token accepted: yes | mint succeeds: yes",
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
    const flaky: ThreadLookup = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "live";
    };
    const store = new ThreadTokenStore(w.directory, w.hosts, w.clock, flaky);
    await store.initialize([route.hostId]);
    const tokens = await mint(store, w.hostToken, lifetime);
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
    refuseRecords();
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
    refuseRecords();
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
    refuseMutations();
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

  it("computes the deletion residual for every subset of refused mutation classes, one and two credential files, and every crash point after the deletion is recorded and during the next start", async () => {
    const yes = (value: boolean) => (value ? "yes" : "no");
    const rows: string[] = [];
    const runs: number[] = [];
    for (const files of [1, 2] as const)
      for (let mask = 0; mask < 16; mask += 1) {
        const faults = new Set(
          FAULT_CLASSES.filter((_, bit) => (mask & (1 << bit)) !== 0),
        );
        const probe = await deletionOutcome(lifetime, faults, files, null);
        const commit = probe.deleteMutations.findIndex(recordsDeletion);
        const outcomes = [probe.outcome];
        if (commit !== -1)
          for (
            let after = commit + 1;
            after < probe.deleteMutations.length;
            after += 1
          )
            outcomes.push(
              (
                await deletionOutcome(lifetime, faults, files, {
                  during: "delete",
                  after,
                })
              ).outcome,
            );
        for (let after = 0; after < probe.restartMutations.length; after += 1)
          outcomes.push(
            (
              await deletionOutcome(lifetime, faults, files, {
                during: "restart",
                after,
              })
            ).outcome,
          );
        rows.push(
          `${files} file${files === 1 ? "" : "s"} | refused: ${[...faults].join("+") || "none"} | record: ${yes(commit !== -1)} | old token accepted: ${yes(outcomes.some((outcome) => outcome.token))} | mint succeeds: ${yes(outcomes.some((outcome) => outcome.mint))}`,
        );
        runs.push(outcomes.length);
      }
    console.log(
      [
        `deletion residual (${lifetime}), bb's first answer live after every restart:`,
        ...rows.map((row, index) => `${row} | runs: ${runs[index]}`),
      ].join("\n"),
    );
    expect(rows).toEqual(EXPECTED_RESIDUAL);
    expect(runs.every((count) => count > 1)).toBe(true);
  }, 600_000);
});
