import fs, { type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { HubTokenStore } from "./store.js";
import {
  ARCHIVE_TOMBSTONE_MAX_AGE_MS,
  ThreadTokenStore,
  type ThreadLookup,
} from "./thread-tokens.js";

const live: ThreadLookup = async () => "live";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

const lifetimes = ["durable", "process"] as const;
type Lifetime = (typeof lifetimes)[number];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bb-tombstone-"));
  directories.push(directory);
  let now = Date.now();
  const clock = () => now;
  const hosts = new HubTokenStore(directory, clock);
  await hosts.initialize();
  const open = async (
    warn?: (message: string) => void,
    lookup: ThreadLookup = live,
  ) => {
    const store = new ThreadTokenStore(directory, hosts, clock, warn);
    await store.initialize(["host-one"], lookup);
    return store;
  };
  const route = {
    hostId: "host-one",
    threadId: "thr_one",
    provider: "claude" as const,
    accountId: null,
  };
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const hostToken = await hosts.forHost(route.hostId);
  return {
    directory,
    hosts,
    open,
    route,
    nestedRoute,
    hostToken,
    clock,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Session = { token: string; nested: string };

async function mint(
  f: Fixture,
  threads: ThreadTokenStore,
  lifetime: Lifetime,
): Promise<Session> {
  return {
    token: await threads.forThread(f.route, f.hostToken, lifetime),
    nested: await threads.forNested(f.nestedRoute, f.hostToken, lifetime),
  };
}

async function accepted(
  f: Fixture,
  threads: ThreadTokenStore,
  session: Session,
): Promise<boolean> {
  const route = await threads.authenticate(session.token, "claude");
  const nested = await threads.authenticateNested(session.nested);
  return (
    route?.threadId === f.route.threadId &&
    nested?.threadId === f.route.threadId
  );
}

async function rejected(
  threads: ThreadTokenStore,
  session: Session,
): Promise<boolean> {
  return (
    (await threads.authenticate(session.token)) === null &&
    (await threads.authenticateNested(session.nested)) === null
  );
}

const unarchive = (threads: ThreadTokenStore, threadId: string) =>
  threads.restoreThread(threadId, threads.archiveVersion(threadId));

const tombstoneNames = async (directory: string) =>
  (await fs.readdir(directory)).filter((name) =>
    name.startsWith("archived-credentials-"),
  );

describe.each(lifetimes)(
  "a %s credential across archive and unarchive",
  (lifetime) => {
    it("is rejected while archived and authenticates again after the same archive is undone", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      expect(await accepted(f, threads, session)).toBe(true);

      await threads.removeThread(f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toHaveLength(1);

      await unarchive(threads, f.route.threadId);
      expect(await accepted(f, threads, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      expect(await threads.authenticate(session.token, "codex")).toBeNull();
    });

    it("stays rejected across a restart while archived and is restorable after it", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const archiving = await f.open();
      await archiving.removeThread(f.route.threadId);

      const restarted = await f.open();
      expect(await rejected(restarted, session)).toBe(true);
      await expect(
        restarted.forThread(f.route, f.hostToken, lifetime),
      ).rejects.toThrow("archived thread");

      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);

      const afterUnarchive = await f.open();
      expect(await accepted(f, afterUnarchive, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);
    });

    it("does not bring a tombstone back once the unarchive has been persisted", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      const [name] = await tombstoneNames(f.directory);
      const kept = await fs.readFile(path.join(f.directory, name ?? ""));
      await unarchive(threads, f.route.threadId);
      await fs.writeFile(path.join(f.directory, name ?? ""), kept);

      const restarted = await f.open();
      expect(await accepted(f, restarted, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);

      await restarted.removeThread(f.route.threadId);
      expect(await rejected(restarted, session)).toBe(true);
    });

    it("restores after a second archive that arrives while the first is pending", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      const firstVersion = threads.archiveVersion(f.route.threadId);
      await threads.removeThread(f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);

      await threads.restoreThread(f.route.threadId, firstVersion);
      expect(await rejected(threads, session)).toBe(true);

      await unarchive(threads, f.route.threadId);
      expect(await accepted(f, threads, session)).toBe(true);
    });

    it("restores after a second archive that follows a restart", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      await (await f.open()).removeThread(f.route.threadId);
      const restarted = await f.open();
      await restarted.removeThread(f.route.threadId);
      expect(await rejected(restarted, session)).toBe(true);
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("restores across repeated archive and unarchive cycles", async () => {
      const f = await fixture();
      let threads = await f.open();
      const session = await mint(f, threads, lifetime);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await threads.removeThread(f.route.threadId);
        expect(await rejected(threads, session)).toBe(true);
        await unarchive(threads, f.route.threadId);
        expect(await accepted(f, threads, session)).toBe(true);
        threads = await f.open();
        expect(await accepted(f, threads, session)).toBe(true);
      }
    });

    it("never restores a credential of a deleted thread", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.deleteThread(f.route.threadId);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await unarchive(threads, f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);
      expect(await rejected(await f.open(), session)).toBe(true);
    });

    it("drops the tombstone when an archived thread is then deleted", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await threads.deleteThread(f.route.threadId);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await unarchive(threads, f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      expect(await rejected(restarted, session)).toBe(true);
    });

    it("never restores a credential whose host generation was reclaimed", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await f.hosts.rotate(f.route.hostId);
      f.advance(10 * 60_000 + 1);
      await unarchive(threads, f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);
    });

    it("never restores once the tombstone has expired, in memory or after a restart", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS - 1);
      const stillValid = await f.open();
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      f.advance(1);
      await unarchive(threads, f.route.threadId);
      expect(await rejected(threads, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await unarchive(stillValid, f.route.threadId);
      expect(await rejected(stillValid, session)).toBe(true);

      const second = await fixture();
      const secondThreads = await second.open();
      const secondSession = await mint(second, secondThreads, lifetime);
      await secondThreads.removeThread(second.route.threadId);
      second.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS);
      const restarted = await second.open();
      expect(await tombstoneNames(second.directory)).toEqual([]);
      await unarchive(restarted, second.route.threadId);
      expect(await rejected(restarted, secondSession)).toBe(true);
    });

    it("stores only digests in the tombstone", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      const [name] = await tombstoneNames(f.directory);
      const text = await fs.readFile(
        path.join(f.directory, name ?? ""),
        "utf8",
      );
      expect(text.includes(session.token)).toBe(false);
      expect(text.includes(session.nested)).toBe(false);
      const digest = createHash("sha256").update(session.token).digest("hex");
      expect(text.includes(digest)).toBe(true);
      expect(
        (await fs.stat(path.join(f.directory, name ?? ""))).mode & 0o777,
      ).toBe(0o600);
    });
  },
);

it("restores the launch credential and every prior a reissue left behind", async () => {
  const f = await fixture();
  const first = await f.open();
  const launch = await mint(f, first, "process");
  const restarted = await f.open();
  const reissued = await mint(f, restarted, "process");
  expect(reissued.token).not.toBe(launch.token);
  expect(await accepted(f, restarted, launch)).toBe(true);

  await restarted.removeThread(f.route.threadId);
  expect(await rejected(restarted, launch)).toBe(true);
  expect(await rejected(restarted, reissued)).toBe(true);

  const afterRestart = await f.open();
  expect(await rejected(afterRestart, launch)).toBe(true);
  await unarchive(afterRestart, f.route.threadId);
  expect(await accepted(f, afterRestart, launch)).toBe(true);
  expect(await accepted(f, afterRestart, reissued)).toBe(true);
});

it("does not restore a credential minted for a different thread", async () => {
  const f = await fixture();
  const threads = await f.open();
  const session = await mint(f, threads, "process");
  const otherRoute = { ...f.route, threadId: "thr_two" };
  const otherToken = await threads.forThread(
    otherRoute,
    f.hostToken,
    "process",
  );
  await threads.removeThread(f.route.threadId);
  await unarchive(threads, otherRoute.threadId);
  expect(await rejected(threads, session)).toBe(true);
  expect(await threads.authenticate(otherToken, "claude")).toEqual(otherRoute);
});

describe.each([
  [
    "an epoch the archive marker does not hold",
    (_: string, value: object) => ({ ...value, epoch: 99 }),
  ],
  [
    "an unknown field",
    (_: string, value: object) => ({ ...value, extra: true }),
  ],
  [
    "a plaintext token",
    (token: string, value: { routes: object[] }) => ({
      ...value,
      routes: value.routes.map((route) => ({ ...route, token })),
    }),
  ],
])("a tombstone with %s", (_name, tamper) => {
  it("is dropped on load and restores nothing", async () => {
    const f = await fixture();
    const threads = await f.open();
    const session = await mint(f, threads, "process");
    await threads.removeThread(f.route.threadId);
    const [name] = await tombstoneNames(f.directory);
    const file = path.join(f.directory, name ?? "");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      routes: object[];
    };
    await fs.writeFile(file, JSON.stringify(tamper(session.token, parsed)));
    const restarted = await f.open();
    expect(await tombstoneNames(f.directory)).toEqual([]);
    await unarchive(restarted, f.route.threadId);
    expect(await rejected(restarted, session)).toBe(true);
  });
});

it("drops a tombstone written with a future archive time", async () => {
  const f = await fixture();
  const threads = await f.open();
  const session = await mint(f, threads, "process");
  await threads.removeThread(f.route.threadId);
  const [name] = await tombstoneNames(f.directory);
  const file = path.join(f.directory, name ?? "");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    archivedAt: number;
  };
  await fs.writeFile(
    file,
    JSON.stringify({ ...parsed, archivedAt: parsed.archivedAt + 3_600_000 }),
  );
  const restarted = await f.open();
  expect(await tombstoneNames(f.directory)).toEqual([]);
  await unarchive(restarted, f.route.threadId);
  expect(await rejected(restarted, session)).toBe(true);
});

describe("a sweep over tombstoned threads", () => {
  const setup = async () => {
    const f = await fixture();
    const threads = await f.open();
    const session = await mint(f, threads, "process");
    await threads.removeThread(f.route.threadId);
    return { f, threads, session };
  };
  const sweepOf =
    (status: "live" | "archived" | "gone"): ThreadLookup =>
    () =>
      Promise.resolve(status);

  it("restores a thread that is live again, as after a missed unarchive event", async () => {
    const { f, threads, session } = await setup();
    const restarted = await f.open();
    const result = await restarted.sweepThreads(sweepOf("live"));
    expect(result).toEqual({ checked: 1, revoked: 0, failed: 0 });
    expect(await accepted(f, restarted, session)).toBe(true);
    expect(await rejected(threads, session)).toBe(true);
  });

  it("keeps the tombstone while the thread stays archived", async () => {
    const { f, threads, session } = await setup();
    const result = await threads.sweepThreads(sweepOf("archived"));
    expect(result).toEqual({ checked: 1, revoked: 0, failed: 0 });
    expect(await tombstoneNames(f.directory)).toHaveLength(1);
    await unarchive(threads, f.route.threadId);
    expect(await accepted(f, threads, session)).toBe(true);
  });

  it("drops the tombstone of a thread that is gone", async () => {
    const { f, threads, session } = await setup();
    await threads.sweepThreads(sweepOf("gone"));
    expect(await tombstoneNames(f.directory)).toEqual([]);
    await unarchive(threads, f.route.threadId);
    expect(await rejected(threads, session)).toBe(true);
  });

  it("purges an expired tombstone without a lookup", async () => {
    const { f, threads } = await setup();
    f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS);
    const result = await threads.sweepThreads(sweepOf("live"));
    expect(result).toEqual({ checked: 0, revoked: 0, failed: 0 });
    expect(await tombstoneNames(f.directory)).toEqual([]);
  });

  it("archives a live-credential thread that the lookup reports archived", async () => {
    const f = await fixture();
    const threads = await f.open();
    const session = await mint(f, threads, "durable");
    const result = await threads.sweepThreads(sweepOf("archived"));
    expect(result).toEqual({ checked: 1, revoked: 1, failed: 0 });
    expect(await rejected(threads, session)).toBe(true);
    await unarchive(threads, f.route.threadId);
    expect(await accepted(f, threads, session)).toBe(true);
  });
});

function failOpening(...markers: string[]) {
  const originalOpen = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementation(((
    file: Parameters<typeof fs.open>[0],
    ...rest: unknown[]
  ) => {
    if (markers.some((marker) => String(file).includes(marker)))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return (originalOpen as (...args: unknown[]) => Promise<unknown>)(
      file,
      ...rest,
    );
  }) as typeof fs.open);
}

describe("a restart in the middle of an archive or an unarchive", () => {
  it("keeps the thread archived and restorable when the unarchive marker cannot be written", async () => {
    const f = await fixture();
    const threads = await f.open();
    const session = await mint(f, threads, "process");
    await threads.removeThread(f.route.threadId);
    const credentialNames = async () =>
      (await fs.readdir(f.directory)).filter((name) =>
        name.startsWith("scoped-"),
      );
    expect(await credentialNames()).toEqual([]);

    const failing = failOpening("archived-thread-", "archive-revocation-");
    try {
      await expect(unarchive(threads, f.route.threadId)).rejects.toThrow("EIO");
    } finally {
      failing.mockRestore();
    }
    expect(await rejected(threads, session)).toBe(true);
    expect(await credentialNames()).not.toEqual([]);

    const restarted = await f.open();
    expect(await rejected(restarted, session)).toBe(true);
    expect(await credentialNames()).toEqual([]);
    expect(await tombstoneNames(f.directory)).toHaveLength(1);

    const result = await restarted.sweepThreads(() => Promise.resolve("live"));
    expect(result).toEqual({ checked: 1, revoked: 0, failed: 0 });
    expect(await accepted(f, restarted, session)).toBe(true);
    expect(await accepted(f, await f.open(), session)).toBe(true);
  });

  it("fails closed when neither archive marker can be written, and mints afresh afterwards", async () => {
    const f = await fixture();
    const threads = await f.open();
    const session = await mint(f, threads, "process");

    const failing = failOpening("archived-thread-", "archive-revocation-");
    try {
      await expect(threads.removeThread(f.route.threadId)).rejects.toThrow(
        "EIO",
      );
    } finally {
      failing.mockRestore();
    }
    expect(await rejected(threads, session)).toBe(true);

    const restarted = await f.open();
    expect(await rejected(restarted, session)).toBe(true);
    expect(await tombstoneNames(f.directory)).toEqual([]);
    const fresh = await mint(f, restarted, "process");
    expect(fresh.token).not.toBe(session.token);
    expect(await accepted(f, restarted, fresh)).toBe(true);
    expect(await rejected(restarted, session)).toBe(true);
  });
});

const scopedFiles = async (directory: string) =>
  (await fs.readdir(directory)).filter((name) => name.startsWith("scoped-"));

async function whileFailing<T>(
  markers: string[],
  action: () => Promise<T>,
): Promise<T> {
  const failing = failOpening(...markers);
  try {
    return await action();
  } finally {
    failing.mockRestore();
  }
}

const TOMBSTONE = ["archived-credentials-"];

async function archiveWithoutTombstone(
  f: Fixture,
  lifetime: Lifetime,
  warn?: (message: string) => void,
) {
  const launch = await mint(f, await f.open(), lifetime);
  const threads = await f.open(warn);
  const current = await mint(f, threads, lifetime);
  expect(current.token).not.toBe(launch.token);
  await archiveFailingTombstone(f, threads);
  return { threads, sessions: [launch, current] };
}

describe.each(lifetimes)(
  "a %s credential when the tombstone cannot be written during an archive",
  (lifetime) => {
    it("keeps the route files, rejects before and after a restart, and restores the original session", async () => {
      const f = await fixture();
      const warn = vi.fn();
      const { threads, sessions } = await archiveWithoutTombstone(
        f,
        lifetime,
        warn,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      expect(await scopedFiles(f.directory)).not.toEqual([]);
      for (const session of sessions)
        expect(await rejected(threads, session)).toBe(true);

      const restarted = await f.open();
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      expect(await scopedFiles(f.directory)).toEqual([]);

      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, restarted, session)).toBe(true);
      const afterUnarchive = await f.open();
      for (const session of sessions.slice(-1))
        expect(await accepted(f, afterUnarchive, session)).toBe(true);
    });

    it("restores in the same process from the memory copy", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      await unarchive(threads, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, threads, session)).toBe(true);
      const restarted = await f.open();
      for (const session of sessions.slice(-1))
        expect(await accepted(f, restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).not.toEqual([]);
    });

    it("recovers from the route files again when the tombstone cannot be written at the restart either", async () => {
      const f = await fixture();
      const warn = vi.fn();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      const restarted = await whileFailing(TOMBSTONE, () => f.open(warn));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await scopedFiles(f.directory)).not.toEqual([]);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
      const again = await whileFailing(TOMBSTONE, () => f.open());
      await unarchive(again, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, again, session)).toBe(true);
      const afterUnarchive = await f.open();
      for (const session of sessions.slice(-1))
        expect(await accepted(f, afterUnarchive, session)).toBe(true);
    });

    it("writes the tombstone and removes the route files on the next sweep", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      const result = await threads.sweepThreads(() =>
        Promise.resolve("archived"),
      );
      expect(result).toEqual({ checked: 1, revoked: 0, failed: 0 });
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      expect(await scopedFiles(f.directory)).toEqual([]);
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("retries the tombstone on a second archive, and keeps the route files while it still fails", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      await whileFailing(TOMBSTONE, () =>
        threads.removeThread(f.route.threadId),
      );
      expect(await tombstoneNames(f.directory)).toEqual([]);
      expect(await scopedFiles(f.directory)).not.toEqual([]);
      const restarted = await whileFailing(TOMBSTONE, () => f.open());
      await restarted.removeThread(f.route.threadId);
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      expect(await scopedFiles(f.directory)).toEqual([]);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("keeps a good tombstone when a second archive's write would fail", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await whileFailing(TOMBSTONE, () =>
        threads.removeThread(f.route.threadId),
      );
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("recovers a later archive episode whose tombstone cannot be written", async () => {
      const f = await fixture();
      let threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await unarchive(threads, f.route.threadId);
      await whileFailing(TOMBSTONE, () =>
        threads.removeThread(f.route.threadId),
      );
      expect(await rejected(threads, session)).toBe(true);
      threads = await f.open();
      expect(await rejected(threads, session)).toBe(true);
      await unarchive(threads, f.route.threadId);
      expect(await accepted(f, threads, session)).toBe(true);
    });

    it("ends final when the thread is deleted in that state, in the same process and after a restart", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      await threads.deleteThread(f.route.threadId);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await unarchive(threads, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(threads, session)).toBe(true);
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);

      const other = await fixture();
      const second = await archiveWithoutTombstone(other, lifetime);
      const afterRestart = await whileFailing(TOMBSTONE, () => other.open());
      await afterRestart.deleteThread(other.route.threadId);
      expect(await scopedFiles(other.directory)).toEqual([]);
      const last = await other.open();
      await unarchive(last, other.route.threadId);
      for (const session of second.sessions)
        expect(await rejected(last, session)).toBe(true);
      expect(await tombstoneNames(other.directory)).toEqual([]);
    });

    it("does not resurrect a pending credential once its tombstone expired", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const restarted = await f.open();
      expect(await scopedFiles(f.directory)).toEqual([]);
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
    });
  },
);

describe.each(lifetimes)(
  "a %s credential whose route files cannot be removed after a good tombstone",
  (lifetime) => {
    it("stays rejected, is not recovered from the leftover file, and restores from the tombstone", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      const leftovers = await scopedFiles(f.directory);
      const originalRemove = fs.rm.bind(fs);
      const remove = vi.spyOn(fs, "rm").mockImplementation((file, options) => {
        if (leftovers.some((name) => String(file).endsWith(name)))
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRemove(file, options);
      });
      const originalRename = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
        if (
          leftovers.some((name) => String(from).endsWith(name)) &&
          String(to).includes("revoked-route-")
        )
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRename(from, to);
      });
      try {
        await threads.removeThread(f.route.threadId);
      } finally {
        remove.mockRestore();
        rename.mockRestore();
      }
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      expect(await scopedFiles(f.directory)).toEqual(leftovers);
      expect(await rejected(threads, session)).toBe(true);

      const restarted = await f.open();
      expect(await rejected(restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });
  },
);

it("removes the route files when neither the tombstone nor an archive marker can be written", async () => {
  const f = await fixture();
  const threads = await f.open();
  const session = await mint(f, threads, "process");
  await whileFailing(
    [...TOMBSTONE, "archived-thread-", "archive-revocation-"],
    async () => {
      await expect(threads.removeThread(f.route.threadId)).rejects.toThrow(
        "EIO",
      );
    },
  );
  expect(await scopedFiles(f.directory)).toEqual([]);
  expect(await rejected(threads, session)).toBe(true);
  const restarted = await f.open();
  expect(await rejected(restarted, session)).toBe(true);
});

async function markerInodes(directory: string): Promise<Map<string, number>> {
  const inodes = new Map<string, number>();
  for (const name of await fs.readdir(directory))
    if (
      name.startsWith("archived-thread-") ||
      name.startsWith("archive-revocation-")
    )
      inodes.set(name, (await fs.stat(path.join(directory, name))).ino);
  return inodes;
}

async function atClockTime<T>(
  f: Fixture,
  action: () => Promise<T>,
): Promise<T> {
  const before = await markerInodes(f.directory);
  const result = await action();
  const stamp = new Date(f.clock());
  for (const [name, inode] of await markerInodes(f.directory))
    if (before.get(name) !== inode)
      await fs.utimes(path.join(f.directory, name), stamp, stamp);
  return result;
}

const archiveFailingTombstone = (f: Fixture, threads: ThreadTokenStore) =>
  atClockTime(f, () =>
    whileFailing(TOMBSTONE, () => threads.removeThread(f.route.threadId)),
  );

const HOUR = 60 * 60_000;

describe.each(lifetimes)(
  "the restoration window of a %s credential counts from the first archive only",
  (lifetime) => {
    it("does not grant a new window to a repeated archive event after expiry, once restarted", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      await archiveFailingTombstone(f, threads);
      const restarted = await whileFailing(TOMBSTONE, () => f.open());
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).toEqual([]);
    });

    it("does not restore in the same process after expiry and a repeated archive event", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      await archiveFailingTombstone(f, threads);
      expect(await scopedFiles(f.directory)).toEqual([]);
      await unarchive(threads, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(threads, session)).toBe(true);
    });

    it("counts expiry from the first archive when events repeat inside the window", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(12 * HOUR);
      await archiveFailingTombstone(f, threads);
      f.advance(13 * HOUR);
      const restarted = await f.open();
      expect(await scopedFiles(f.directory)).toEqual([]);
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await rejected(restarted, session)).toBe(true);
    });

    it("still restores inside the window after repeated archive events and a restart", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(12 * HOUR);
      await archiveFailingTombstone(f, threads);
      f.advance(11 * HOUR);
      const restarted = await whileFailing(TOMBSTONE, () => f.open());
      await archiveFailingTombstone(f, restarted);
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("never restores a pending credential a sweep finds past expiry", async () => {
      const f = await fixture();
      const { threads, sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      await threads.sweepThreads(() => Promise.resolve("live"));
      expect(await scopedFiles(f.directory)).toEqual([]);
      for (const session of sessions)
        expect(await rejected(threads, session)).toBe(true);
    });

    it("does not rewrite the archive marker for a repeated archive event, before or after a restart", async () => {
      const f = await fixture();
      const threads = await f.open();
      await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      const first = await markerInodes(f.directory);
      expect(first.size).toBe(1);
      await threads.removeThread(f.route.threadId);
      expect(await markerInodes(f.directory)).toEqual(first);
      const restarted = await f.open();
      await restarted.removeThread(f.route.threadId);
      expect(await markerInodes(f.directory)).toEqual(first);
    });

    it("keeps a durable tombstone's window at the first archive too", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await atClockTime(f, () => threads.removeThread(f.route.threadId));
      f.advance(12 * HOUR);
      await atClockTime(f, () => threads.removeThread(f.route.threadId));
      f.advance(13 * HOUR);
      await atClockTime(f, () => threads.removeThread(f.route.threadId));
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      expect(await scopedFiles(f.directory)).toEqual([]);
    });
  },
);

function failReading(...markers: string[]) {
  const originalReadFile = fs.readFile.bind(fs);
  return vi.spyOn(fs, "readFile").mockImplementation(((
    file: Parameters<typeof fs.readFile>[0],
    ...rest: unknown[]
  ) => {
    if (markers.some((marker) => String(file).includes(marker)))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return (originalReadFile as (...args: unknown[]) => Promise<unknown>)(
      file,
      ...rest,
    );
  }) as typeof fs.readFile);
}

const MARKERS = ["archived-thread-", "archive-revocation-"];

async function whileUnreadable<T>(action: () => Promise<T>): Promise<T> {
  const failing = failReading(...MARKERS);
  try {
    return await action();
  } finally {
    failing.mockRestore();
  }
}

async function expectNothingRestorable(
  f: Fixture,
  threads: ThreadTokenStore,
  sessions: Session[],
) {
  await unarchive(threads, f.route.threadId);
  for (const session of sessions)
    expect(await rejected(threads, session)).toBe(true);
  expect(await scopedFiles(f.directory)).toEqual([]);
  expect(await tombstoneNames(f.directory)).toEqual([]);
}

describe.each(lifetimes)(
  "a %s credential whose archive epoch cannot be established",
  (lifetime) => {
    it("is not restorable when the marker is unreadable but writable and the archive event repeats", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const restarted = await whileUnreadable(async () => {
        const store = await f.open();
        await archiveFailingTombstone(f, store);
        return store;
      });
      await expectNothingRestorable(f, restarted, sessions);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("is not restorable when the marker is unreadable only at startup", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const restarted = await whileUnreadable(() => f.open());
      await archiveFailingTombstone(f, restarted);
      await expectNothingRestorable(f, restarted, sessions);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("is not restorable inside the window either, when the epoch was lost", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(HOUR);
      const restarted = await whileUnreadable(() => f.open());
      await archiveFailingTombstone(f, restarted);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("stays rejected and unrestorable when the pending files cannot be deleted", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      const restarted = await whileUnreadable(() => f.open());
      const originalRemove = fs.rm.bind(fs);
      const remove = vi.spyOn(fs, "rm").mockImplementation((file, options) => {
        if (String(file).includes("scoped-"))
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRemove(file, options);
      });
      const originalRename = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
        if (String(from).includes("scoped-"))
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRename(from, to);
      });
      try {
        await archiveFailingTombstone(f, restarted);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
      } finally {
        remove.mockRestore();
        rename.mockRestore();
      }
      const again = await f.open();
      await expectNothingRestorable(f, again, sessions);
    });

    it("is not restorable when the marker is corrupt and the archive event repeats", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const marker = (await fs.readdir(f.directory)).find((name) =>
        name.startsWith("archived-thread-"),
      );
      await fs.writeFile(path.join(f.directory, marker ?? ""), "{broken");
      const restarted = await f.open();
      await archiveFailingTombstone(f, restarted);
      await expectNothingRestorable(f, restarted, sessions);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("still restores inside the window with a healthy marker, across a restart", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(HOUR);
      const restarted = await f.open();
      await unarchive(restarted, f.route.threadId);
      for (const session of sessions)
        expect(await accepted(f, restarted, session)).toBe(true);
    });
  },
);

const flush = (threads: ThreadTokenStore) =>
  threads.sweepThreads(() => Promise.resolve("archived"));

describe.each(lifetimes)(
  "a %s credential when the marker is unreadable only at startup and a live session then resolves it",
  (lifetime) => {
    it("is dropped once the marker reads back, even before any archive event repeats", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(HOUR);
      const restarted = await whileUnreadable(() => f.open());
      await expect(
        restarted.forThread(f.route, f.hostToken, lifetime),
      ).rejects.toThrow("archived thread");
      await flush(restarted);
      expect(await scopedFiles(f.directory)).toEqual([]);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("is dropped when the archive event repeats afterwards, past expiry", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const restarted = await whileUnreadable(() => f.open());
      await expect(
        restarted.forThread(f.route, f.hostToken, lifetime),
      ).rejects.toThrow("archived thread");
      await archiveFailingTombstone(f, restarted);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("is dropped when the archive event repeats afterwards, inside the window", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      f.advance(HOUR);
      const restarted = await whileUnreadable(() => f.open());
      await expect(
        restarted.forThread(f.route, f.hostToken, lifetime),
      ).rejects.toThrow("archived thread");
      await archiveFailingTombstone(f, restarted);
      await expectNothingRestorable(f, await f.open(), sessions);
    });

    it("stays rejected in the same process when the pending files cannot be deleted", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      const restarted = await whileUnreadable(() => f.open());
      const originalRemove = fs.rm.bind(fs);
      const remove = vi.spyOn(fs, "rm").mockImplementation((file, options) => {
        if (String(file).includes("scoped-"))
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRemove(file, options);
      });
      const originalRename = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
        if (String(from).includes("scoped-"))
          return Promise.reject(
            Object.assign(new Error("EIO"), { code: "EIO" }),
          );
        return originalRename(from, to);
      });
      try {
        await archiveFailingTombstone(f, restarted);
        await unarchive(restarted, f.route.threadId);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
      } finally {
        remove.mockRestore();
        rename.mockRestore();
      }
    });
  },
);

const crash = (): Error => Object.assign(new Error("crashed"), { code: "EIO" });

const MUTATING_FS = new Set([
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "lchmod",
  "lchown",
  "link",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "mkdtempDisposable",
  "open",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
]);
const READ_ONLY_FS = new Set([
  "access",
  "glob",
  "lstat",
  "opendir",
  "readdir",
  "readFile",
  "readlink",
  "realpath",
  "stat",
  "statfs",
  "watch",
]);
const MUTATING_HANDLE = new Set([
  "appendFile",
  "chmod",
  "chown",
  "close",
  "createWriteStream",
  "datasync",
  "sync",
  "truncate",
  "utimes",
  "write",
  "writeFile",
  "writev",
]);
const READ_ONLY_HANDLE = new Set([
  "createReadStream",
  "read",
  "readFile",
  "readLines",
  "readableWebStream",
  "readv",
  "stat",
]);
const EVENT_HANDLE = new Set([
  "addListener",
  "emit",
  "eventNames",
  "getAsyncId",
  "getMaxListeners",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "removeAllListeners",
  "removeListener",
  "setMaxListeners",
]);

function crashAfter(mutations: number) {
  const target = fs as unknown as Record<string, unknown>;
  let done = 0;
  let dead = mutations === 0;
  const counted: string[] = [];
  const unclassified = new Set<string>();
  const count = (name: string) => {
    counted.push(name);
    done += 1;
    if (done >= mutations) dead = true;
  };
  const mutate = async <T>(name: string, action: () => Promise<T>) => {
    if (dead) throw crash();
    const result = await action();
    count(name);
    return result;
  };
  const wrap = (handle: FileHandle): FileHandle =>
    new Proxy(handle, {
      get(owner, key) {
        const value: unknown = Reflect.get(owner, key);
        if (typeof value !== "function" || typeof key !== "string")
          return value;
        const call = (value as (...args: unknown[]) => Promise<unknown>).bind(
          owner,
        );
        if (key === "close")
          return async () => {
            await call();
            if (dead) throw crash();
            count("handle.close");
          };
        if (MUTATING_HANDLE.has(key))
          return (...args: unknown[]) =>
            mutate(`handle.${key}`, () => call(...args));
        if (!READ_ONLY_HANDLE.has(key) && !EVENT_HANDLE.has(key))
          unclassified.add(`handle.${key}`);
        return call;
      },
    });
  const spies = Object.keys(target).flatMap((name) => {
    const original = target[name];
    if (typeof original !== "function") return [];
    const real = (original as (...args: unknown[]) => Promise<unknown>).bind(
      fs,
    );
    const spy = (
      vi.spyOn as unknown as (object: unknown, method: string) => MockInstance
    )(target, name).mockImplementation(((...args: unknown[]) => {
      if (!MUTATING_FS.has(name) && !READ_ONLY_FS.has(name))
        unclassified.add(name);
      if (name === "open")
        return (async () => {
          const flags = args[1];
          const creates = typeof flags === "string" && flags !== "r";
          if (!creates && dead) throw crash();
          const handle = (
            creates
              ? await mutate("open", () => real(...args))
              : await real(...args)
          ) as FileHandle;
          return wrap(handle);
        })();
      if (MUTATING_FS.has(name)) return mutate(name, () => real(...args));
      return real(...args);
    }) as never);
    return [spy];
  });
  return {
    get dead() {
      return dead;
    },
    get counted() {
      return counted;
    },
    get unclassified() {
      return [...unclassified];
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

const bbArchived: ThreadLookup = async () => "archived";
const archivedAt =
  (at: number): ThreadLookup =>
  async () => ({ status: "archived", archivedAt: at });
const unreachable: ThreadLookup = async () => {
  throw new Error("bb is unreachable");
};

const markerTemporaries = async (directory: string) =>
  (await fs.readdir(directory)).filter(
    (name) =>
      (name.startsWith("archived-thread-") ||
        name.startsWith("archive-revocation-")) &&
      name.endsWith(".tmp"),
  );

type Archiver = (threads: ThreadTokenStore, f: Fixture) => Promise<unknown>;
type WalkOptions = { archive?: Archiver; anchored?: boolean };

async function everyCrashPoint(
  lifetime: Lifetime,
  body: (f: Fixture, sessions: Session[], writes: number) => Promise<void>,
  options: WalkOptions = {},
) {
  const archive: Archiver =
    options.archive ?? ((threads, f) => threads.removeThread(f.route.threadId));
  let crashes = 0;
  for (let writes = 0; writes < 160; writes += 1) {
    const f = await fixture();
    const launch = await mint(f, await f.open(), lifetime);
    const threads = await f.open();
    const sessions = [launch, await mint(f, threads, lifetime)];
    const before = await markerInodes(f.directory);
    const interruption = crashAfter(writes);
    await archive(threads, f).catch(() => undefined);
    const crashed = interruption.dead;
    interruption.restore();
    if (options.anchored !== true) {
      const stamp = new Date(f.clock());
      for (const [name, inode] of await markerInodes(f.directory))
        if (before.get(name) !== inode)
          await fs.utimes(path.join(f.directory, name), stamp, stamp);
    }
    if (!crashed) {
      expect(writes).toBeGreaterThan(12);
      break;
    }
    crashes += 1;
    await body(f, sessions, writes);
  }
  expect(crashes).toBeGreaterThan(12);
}

const lateArchive =
  (ageMs: number): Archiver =>
  (threads, f) =>
    threads.sweepThreads(archivedAt(f.clock() - ageMs));

const markersCarryTheAnchor = async (directory: string, anchor: number) => {
  for (const name of await fs.readdir(directory))
    if (
      (name.startsWith("archived-thread-") ||
        name.startsWith("archive-revocation-")) &&
      name.endsWith(".json")
    )
      expect(
        Math.abs((await fs.stat(path.join(directory, name))).mtimeMs - anchor),
      ).toBeLessThan(2_000);
};

describe.each(lifetimes)(
  "a %s credential across a crash at every mutation of an archive",
  (lifetime) => {
    it("is rejected at once after a restart at every crash point, and nothing restores past expiry", async () => {
      await everyCrashPoint(lifetime, async (f, sessions) => {
        const bb = archivedAt(f.clock());
        f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
        const restarted = await f.open(undefined, bb);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
        await restarted.sweepThreads(bb);
        await archiveFailingTombstone(f, restarted);
        await restarted.sweepThreads(bb);
        const again = await f.open(undefined, bb);
        for (const session of sessions)
          expect(await rejected(again, session)).toBe(true);
        await expectNothingRestorable(f, again, sessions);
      });
    });

    it("restores nothing past expiry when unarchived right after the first restart, whatever the crash point", async () => {
      await everyCrashPoint(lifetime, async (f, sessions) => {
        const bb = archivedAt(f.clock());
        f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
        const restarted = await f.open(undefined, bb);
        await expectNothingRestorable(f, restarted, sessions);
      });
    });

    it("is rejected at once after a restart at every crash point, and restores inside the window only what the archive kept", async () => {
      await everyCrashPoint(lifetime, async (f, sessions) => {
        const lostMarker = (await markerTemporaries(f.directory)).length > 0;
        const bb = archivedAt(f.clock());
        f.advance(HOUR);
        const restarted = await f.open(undefined, bb);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
        await restarted.sweepThreads(bb);
        await atClockTime(f, () => restarted.removeThread(f.route.threadId));
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
        const again = await f.open(undefined, bb);
        for (const session of sessions)
          expect(await rejected(again, session)).toBe(true);
        await unarchive(again, f.route.threadId);
        for (const session of sessions)
          expect(await accepted(f, again, session)).toBe(!lostMarker);
      });
    });

    it("is rejected at once when bb cannot be asked after the restart, whatever the crash point", async () => {
      await everyCrashPoint(lifetime, async (f, sessions) => {
        const restarted = await f.open(undefined, unreachable);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
        await restarted.sweepThreads(bbArchived);
        for (const session of sessions)
          expect(await rejected(restarted, session)).toBe(true);
      });
    });

    it("is rejected at once from the disk alone once the archive marker or its temporary file exists, even if bb answers live", async () => {
      await everyCrashPoint(lifetime, async (f, sessions, writes) => {
        const evidence =
          (await markerInodes(f.directory)).size > 0 ||
          (await tombstoneNames(f.directory)).length > 0;
        const restarted = await f.open(undefined, live);
        for (const session of sessions.slice(-1))
          expect(await rejected(restarted, session)).toBe(evidence);
        if (writes > 0) expect(evidence).toBe(true);
      });
    });
  },
);

describe.each(lifetimes)(
  "a %s credential archived by a late reconcile, across a crash at every mutation",
  (lifetime) => {
    const late = { archive: lateArchive(30 * HOUR), anchored: true };

    it("is rejected at once and restores nothing when bb archived it beyond the window, with bb answering", async () => {
      await everyCrashPoint(
        lifetime,
        async (f, sessions) => {
          await markersCarryTheAnchor(f.directory, f.clock() - 30 * HOUR);
          const bb = archivedAt(f.clock() - 30 * HOUR);
          const restarted = await f.open(undefined, bb);
          for (const session of sessions)
            expect(await rejected(restarted, session)).toBe(true);
          await restarted.sweepThreads(bb);
          await archiveFailingTombstone(f, restarted);
          const again = await f.open(undefined, bb);
          for (const session of sessions)
            expect(await rejected(again, session)).toBe(true);
          await expectNothingRestorable(f, again, sessions);
        },
        late,
      );
    });

    it("is rejected at once and restores nothing when bb cannot be asked, once the archive reached the disk", async () => {
      await everyCrashPoint(
        lifetime,
        async (f, sessions, writes) => {
          const restarted = await f.open(undefined, unreachable);
          for (const session of sessions)
            expect(await rejected(restarted, session)).toBe(true);
          if (writes === 0) return;
          await unarchive(restarted, f.route.threadId);
          for (const session of sessions)
            expect(await rejected(restarted, session)).toBe(true);
          expect(await scopedFiles(f.directory)).toEqual([]);
          expect(await tombstoneNames(f.directory)).toEqual([]);
        },
        late,
      );
    });

    it("restores nothing right after the first restart, whatever the crash point", async () => {
      await everyCrashPoint(
        lifetime,
        async (f, sessions) => {
          const restarted = await f.open(
            undefined,
            archivedAt(f.clock() - 30 * HOUR),
          );
          await expectNothingRestorable(f, restarted, sessions);
        },
        late,
      );
    });

    it("counts the window from bb's archive time when the archive was 12 hours ago", async () => {
      const inside = { archive: lateArchive(12 * HOUR), anchored: true };
      await everyCrashPoint(
        lifetime,
        async (f, sessions) => {
          const lostMarker = (await markerTemporaries(f.directory)).length > 0;
          await markersCarryTheAnchor(f.directory, f.clock() - 12 * HOUR);
          const bb = archivedAt(f.clock() - 12 * HOUR);
          f.advance(HOUR);
          const restarted = await f.open(undefined, bb);
          for (const session of sessions)
            expect(await rejected(restarted, session)).toBe(true);
          await unarchive(restarted, f.route.threadId);
          for (const session of sessions)
            expect(await accepted(f, restarted, session)).toBe(!lostMarker);
        },
        inside,
      );
      await everyCrashPoint(
        lifetime,
        async (f, sessions) => {
          const bb = archivedAt(f.clock() - 12 * HOUR);
          f.advance(13 * HOUR);
          const restarted = await f.open(undefined, bb);
          for (const session of sessions)
            expect(await rejected(restarted, session)).toBe(true);
          await expectNothingRestorable(f, restarted, sessions);
        },
        inside,
      );
    });
  },
);

describe.each(lifetimes)(
  "a %s credential and the earlier of bb's archive time and the marker's",
  (lifetime) => {
    it("recovers no pending files into a tombstone when bb archived beyond the window, whatever the marker's modification time", async () => {
      const f = await fixture();
      const { sessions } = await archiveWithoutTombstone(f, lifetime);
      const archivedBefore = f.clock();
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const fresh = new Date(f.clock());
      for (const name of await fs.readdir(f.directory))
        if (name.startsWith("archived-thread-"))
          await fs.utimes(path.join(f.directory, name), fresh, fresh);
      const restarted = await f.open(undefined, archivedAt(archivedBefore));
      expect(await tombstoneNames(f.directory)).toEqual([]);
      expect(await scopedFiles(f.directory)).toEqual([]);
      await expectNothingRestorable(f, restarted, sessions);
    });

    it("clamps a durable tombstone to bb's earlier archive time", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const archivedBefore = f.clock();
      await (await f.open()).removeThread(f.route.threadId);
      f.advance(ARCHIVE_TOMBSTONE_MAX_AGE_MS + 1_000);
      const [name] = await tombstoneNames(f.directory);
      const file = path.join(f.directory, name ?? "");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as {
        archivedAt: number;
      };
      stored.archivedAt = f.clock();
      await fs.writeFile(file, JSON.stringify(stored));
      const restarted = await f.open(undefined, archivedAt(archivedBefore));
      await expectNothingRestorable(f, restarted, [session]);
    });

    it("keeps the earlier time when the marker is older than bb's", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      await atClockTime(f, async () =>
        (await f.open()).removeThread(f.route.threadId),
      );
      f.advance(HOUR);
      const restarted = await f.open(undefined, archivedAt(f.clock()));
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });
  },
);

describe("every filesystem call the archive path makes", () => {
  it("is one the crash injector counts or knows to be read-only", async () => {
    const f = await fixture();
    await mint(f, await f.open(), "durable");
    const threads = await f.open();
    await mint(f, threads, "process");
    const interruption = crashAfter(Number.MAX_SAFE_INTEGER);
    try {
      await threads.sweepThreads(archivedAt(f.clock() - HOUR));
      await unarchive(threads, f.route.threadId);
      await mint(f, threads, "durable");
      await threads.removeThread(f.route.threadId);
      await f.open(undefined, bbArchived);
    } finally {
      interruption.restore();
    }
    expect(interruption.unclassified).toEqual([]);
    expect(interruption.counted).toEqual(
      expect.arrayContaining([
        "open",
        "handle.writeFile",
        "handle.sync",
        "handle.utimes",
        "handle.close",
        "rename",
        "rm",
        "mkdir",
        "chmod",
      ]),
    );
  });
});

describe.each(lifetimes)(
  "a %s credential whose archive marker was interrupted before its rename",
  (lifetime) => {
    const writeTemporary = (f: Fixture, state: string, prefix?: string) =>
      fs.writeFile(
        path.join(
          f.directory,
          `${prefix ?? "archived-thread-"}${createHash("sha256")
            .update(f.route.threadId)
            .digest(
              "hex",
            )}.json.${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`,
        ),
        state,
      );

    it("treats a complete temporary marker as the archive but grants no restoration window", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await writeTemporary(
        f,
        JSON.stringify({
          threadId: f.route.threadId,
          epoch: 1,
          archived: true,
        }),
      );
      const restarted = await f.open(undefined, live);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await markerTemporaries(f.directory)).toEqual([]);
      expect((await markerInodes(f.directory)).size).toBe(1);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await expectNothingRestorable(f, restarted, [session]);
    });

    it("treats an empty or truncated temporary marker like an unreadable marker and recovers when the thread is unarchived", async () => {
      for (const state of ["", '{"threadId":"thr_one","epo']) {
        const f = await fixture();
        const threads = await f.open();
        const session = await mint(f, threads, lifetime);
        await writeTemporary(f, state);
        const restarted = await f.open(undefined, live);
        expect(await rejected(restarted, session)).toBe(true);
        expect(await scopedFiles(f.directory)).toEqual([]);
        await expect(
          restarted.forThread(f.route, f.hostToken, lifetime),
        ).rejects.toThrow("archived thread");
        await unarchive(restarted, f.route.threadId);
        expect(await markerTemporaries(f.directory)).toEqual([]);
        const minted = await mint(f, restarted, lifetime);
        expect(await accepted(f, restarted, minted)).toBe(true);
      }
    });

    it("ignores a stale unarchive temporary and keeps the thread archived", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await writeTemporary(
        f,
        JSON.stringify({
          threadId: f.route.threadId,
          epoch: 2,
          archived: false,
        }),
      );
      const restarted = await f.open(undefined, live);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await markerTemporaries(f.directory)).toEqual([]);
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("discards an unreadable temporary when a readable archived marker already exists", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await threads.removeThread(f.route.threadId);
      await writeTemporary(f, '{"threadId":');
      const restarted = await f.open(undefined, live);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await markerTemporaries(f.directory)).toEqual([]);
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("reads the fallback marker's temporary the same way", async () => {
      const f = await fixture();
      const threads = await f.open();
      const session = await mint(f, threads, lifetime);
      await writeTemporary(
        f,
        JSON.stringify({
          threadId: f.route.threadId,
          epoch: 1,
          archived: true,
        }),
        "archive-revocation-",
      );
      const restarted = await f.open(undefined, live);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await markerTemporaries(f.directory)).toEqual([]);
    });
  },
);

describe.each(lifetimes)(
  "a %s credential loaded at startup is trusted only after bb answers",
  (lifetime) => {
    it("is rejected until a sweep can reach bb, then accepted when the thread is live", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const restarted = await f.open(undefined, unreachable);
      expect(await rejected(restarted, session)).toBe(true);
      await restarted.sweepThreads(unreachable);
      expect(await rejected(restarted, session)).toBe(true);
      await restarted.sweepThreads(live);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("is revoked while the store loads when bb already has the thread archived", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const restarted = await f.open(undefined, bbArchived);
      expect(await rejected(restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toHaveLength(1);
      await unarchive(restarted, f.route.threadId);
      expect(await accepted(f, restarted, session)).toBe(true);
    });

    it("is deleted while the store loads when bb no longer has the thread", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const restarted = await f.open(undefined, async () => "gone");
      expect(await rejected(restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toEqual([]);
    });

    it("counts the restoration window from when bb archived the thread, not from the late reconcile", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      f.advance(23 * HOUR);
      const restarted = await f.open(
        undefined,
        archivedAt(f.clock() - 23 * HOUR),
      );
      expect(await rejected(restarted, session)).toBe(true);
      f.advance(2 * HOUR);
      const later = await f.open(undefined, bbArchived);
      await expectNothingRestorable(f, later, [session]);
    });

    it("keeps no tombstone for a thread bb archived longer ago than the window", async () => {
      const f = await fixture();
      const session = await mint(f, await f.open(), lifetime);
      const restarted = await f.open(
        undefined,
        archivedAt(f.clock() - 30 * HOUR),
      );
      expect(await rejected(restarted, session)).toBe(true);
      expect(await scopedFiles(f.directory)).toEqual([]);
      expect(await tombstoneNames(f.directory)).toEqual([]);
      await expectNothingRestorable(f, restarted, [session]);
    });

    it("accepts a credential minted for a loaded thread once bb has said it is live, though the lookup failed at startup", async () => {
      const f = await fixture();
      await mint(f, await f.open(), lifetime);
      const restarted = await f.open(undefined, unreachable);
      await unarchive(restarted, f.route.threadId);
      const minted = await mint(f, restarted, lifetime);
      expect(await accepted(f, restarted, minted)).toBe(true);
    });

    it("keeps trusting a credential minted after the load", async () => {
      const f = await fixture();
      const restarted = await f.open(undefined, unreachable);
      const session = await mint(f, restarted, lifetime);
      expect(await accepted(f, restarted, session)).toBe(true);
    });
  },
);
