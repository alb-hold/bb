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
});
