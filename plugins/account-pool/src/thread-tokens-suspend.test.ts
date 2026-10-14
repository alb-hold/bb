import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubTokenStore } from "./store.js";
import {
  ARCHIVED_STATE_RECHECK_MS,
  ThreadTokenStore,
  type ThreadLookup,
} from "./thread-tokens.js";

type BbState = "live" | "archived" | "gone";
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
  const clock = () => now;
  const lookup: ThreadLookup = async () => {
    lookups += 1;
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

function crashAfter(mutations: number): { crashed: () => boolean } {
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

  it("accepts the tokens again after a missed unarchive event once bb reports the thread live", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    w.setBb("live");
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    w.advance(ARCHIVED_STATE_RECHECK_MS);
    expect(await accepted(store, tokens)).toEqual({
      token: true,
      nested: true,
    });
  });

  it("rechecks an archived thread with bb at most once per interval", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    await store.suspendThread(route.threadId);
    const before = w.lookups();
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await store.authenticate(tokens.token)).toBeNull();
    expect(w.lookups()).toBe(before);
    w.advance(ARCHIVED_STATE_RECHECK_MS);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await store.authenticate(tokens.token)).toBeNull();
    expect(w.lookups()).toBe(before + 1);
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
    w.advance(ARCHIVED_STATE_RECHECK_MS);
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

  it("removes the files when no archive marker can be written, yet accepts the tokens after an in-process unarchive", async () => {
    const w = await world();
    const store = await w.open();
    const tokens = await mint(store, w.hostToken, lifetime);
    w.setBb("archived");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).includes("archive"))
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      return originalOpen(file, flags, mode);
    });
    await expect(store.suspendThread(route.threadId)).rejects.toThrow("ENOSPC");
    vi.restoreAllMocks();
    expect(await accepted(store, tokens)).toEqual({
      token: false,
      nested: false,
    });
    const offline = new ThreadTokenStore(w.directory, w.hosts);
    await offline.initialize([route.hostId]);
    expect(await accepted(offline, tokens)).toEqual({
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
    const restarted = await w.open();
    expect(await accepted(restarted, tokens)).toEqual({
      token: true,
      nested: true,
    });
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
    w.advance(ARCHIVED_STATE_RECHECK_MS);
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
});
