import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubTokenStore } from "./store.js";
import {
  ARCHIVE_TOMBSTONE_MAX_AGE_MS,
  ThreadTokenStore,
  type ThreadLookup,
} from "./thread-tokens.js";

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
  const open = async (warn?: (message: string) => void) => {
    const store = new ThreadTokenStore(directory, hosts, clock, warn);
    await store.initialize(["host-one"]);
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
  await whileFailing(TOMBSTONE, () => threads.removeThread(f.route.threadId));
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
