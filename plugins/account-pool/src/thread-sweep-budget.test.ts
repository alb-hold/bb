import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(count = 3000) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "pool-sweep-budget-"));
  directories.push(directory);
  const hosts = new HubTokenStore(directory);
  await hosts.initialize();
  const hostToken = await hosts.forHost("host-one");
  const mint = new ThreadTokenStore(directory, hosts);
  await mint.initialize(["host-one"]);
  const tokens = new Map<string, string>();
  if (count > 0)
    tokens.set(
      "thr_0000",
      await mint.forThread(
        {
          hostId: "host-one",
          threadId: "thr_0000",
          provider: "claude",
          accountId: null,
        },
        hostToken,
      ),
    );
  const hostTokenDigest = createHash("sha256").update(hostToken).digest("hex");
  for (let i = 1; i < count; i += 1) {
    const threadId = `thr_${String(i).padStart(4, "0")}`;
    const token = randomBytes(32).toString("base64url");
    tokens.set(threadId, token);
    await fs.writeFile(
      path.join(
        directory,
        `scoped-route-host-one-claude-${threadId}-automatic-${hostTokenDigest}-v0.json`,
      ),
      JSON.stringify({
        hostId: "host-one",
        threadId,
        provider: "claude",
        accountId: null,
        hostTokenDigest,
        tokenDigest: createHash("sha256").update(token).digest("hex"),
      }),
      { mode: 0o600 },
    );
  }
  const store = new ThreadTokenStore(directory, hosts);
  await store.initialize(["host-one"]);
  return { store, tokens, directory, hosts };
}

it.each([
  { count: 2697, lookupMs: 25, calls: 2697, elapsed: 2125, deferred: 0 },
  { count: 3000, lookupMs: 25, calls: 3000, elapsed: 2350, deferred: 0 },
  { count: 2697, lookupMs: 200, calls: 2400, elapsed: 15000, deferred: 329 },
])(
  "sweeps $count routed threads with $lookupMs ms lookups under the production budget",
  async ({ count, lookupMs, calls: expectedCalls, elapsed: expectedElapsed, deferred }) => {
    const { store, tokens } = await fixture(count);
    let calls = 0;
    let active = 0;
    let peak = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    const signal = AbortSignal.timeout(15000);
    const started = performance.now();
    let settled = false;
    const sweep = store.sweepThreads(
      async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, lookupMs));
        active -= 1;
        return "live";
      },
      { signal, lookupTimeoutMs: 5000 },
    );
    void sweep.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await yieldToIo();
      if (active > 0) await vi.advanceTimersByTimeAsync(25);
    }
    const result = await sweep;
    const elapsed = performance.now() - started;
    expect(elapsed).toBe(expectedElapsed);
    expect(result.failed).toBe(0);
    expect(calls).toBe(expectedCalls);
    expect(result.deferred).toBe(deferred);
    expect(result.checked).toBe(expectedCalls);
    expect(signal.aborted).toBe(deferred > 0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    console.log(
      `sweep routes=${tokens.size} threads.get=${calls} virtual_elapsed_ms=${elapsed}`,
    );
  },
  60000,
);

it("revokes every missed archived thread beyond the old cutoff in one sweep, omits suspended routes from later sweeps, and preserves undo", async () => {
  const { store, tokens } = await fixture();
  const archived = [...tokens.keys()].slice(-100);
  const budget = new AbortController();
  const result = await store.sweepThreads(
    async (id) => (archived.includes(id) ? "archived" : "live"),
    { signal: budget.signal, lookupTimeoutMs: 5000 },
  );
  expect(result).toMatchObject({
    checked: tokens.size,
    failed: 0,
    deferred: 0,
  });
  for (const id of archived)
    expect(await store.authenticate(tokens.get(id) ?? "")).toBeNull();
  const checked = new Set<string>();
  await store.sweepThreads(async (id) => {
    checked.add(id);
    return "live";
  });
  for (const id of archived) expect(checked.has(id)).toBe(false);
  expect(checked.size).toBe(2900);
  const id = archived[0];
  if (id === undefined) throw new Error("missing archived fixture");
  await store.restoreThread(id, store.archiveVersion(id), true);
  expect((await store.authenticate(tokens.get(id) ?? ""))?.threadId).toBe(id);
}, 60000);

it("rechecks budget-deferred in-flight threads before unreached threads", async () => {
  const { store } = await fixture();
  const budget = new AbortController();
  const first: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await store.sweepThreads(
    async (id) => {
      first.push(id);
      timer ??= setTimeout(() => budget.abort(), 20);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "live";
    },
    { signal: budget.signal, lookupTimeoutMs: 5000 },
  );
  clearTimeout(timer);
  expect(first.length).toBeGreaterThan(0);
  expect(result.failed).toBe(0);
  expect(result).toMatchObject({ deferred: 3000 });
  let next: string | undefined;
  await store.sweepThreads(async (id) => {
    next ??= id;
    return "live";
  });
  expect(next).toBeDefined();
  expect(next).toBe(first[0]);
}, 60000);

it("persists completed progress so repeated restarts reach and revoke late archived threads within three sweeps", async () => {
  const { directory, hosts, tokens } = await fixture();
  const reached = new Set<string>();
  let expectedFirst = "thr_0000";
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const store = new ThreadTokenStore(directory, hosts);
    await store.initialize(["host-one"]);
    const budget = new AbortController();
    const calls: string[] = [];
    await store.sweepThreads(
      async (id) => {
        calls.push(id);
        if (calls.length > 1024) {
          budget.abort();
          return new Promise(() => undefined);
        }
        reached.add(id);
        return id >= "thr_2900" ? "archived" : "live";
      },
      { signal: budget.signal },
    );
    expect(calls[0]).toBe(expectedFirst);
    expectedFirst = calls[1024] ?? "thr_0000";
  }
  expect(reached.size).toBe(3000);
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  for (const [id, token] of tokens)
    if (id >= "thr_2900")
      expect(await restarted.authenticate(token)).toBeNull();
}, 60000);

it("counts archive persistence errors as failed even when the sweep budget expires after lookup completion", async () => {
  const { store } = await fixture(1);
  const budget = new AbortController();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    const name = path.basename(String(target));
    if (
      name.startsWith("archived-thread-") ||
      name.startsWith("archive-revocation-")
    ) {
      budget.abort();
      throw new Error("archive persistence unavailable");
    }
    return rename(source, target);
  });
  const result = await store.sweepThreads(async () => "archived", {
    signal: budget.signal,
  });
  expect(result).toMatchObject({ checked: 1, failed: 1, deferred: 0 });
});

it("warns when a persisted incomplete rotation exceeds one hour without warning again after a restart", async () => {
  const { directory, hosts } = await fixture(96);
  let now = 1000;
  const warnings: string[] = [];
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const store = new ThreadTokenStore(
      directory,
      hosts,
      () => now,
      undefined,
      5000,
      (message) => warnings.push(message),
    );
    await store.initialize(["host-one"]);
    const budget = new AbortController();
    await store.sweepThreads(
      async () => {
        budget.abort();
        return new Promise(() => undefined);
      },
      { signal: budget.signal },
    );
    now += 3600001;
  }
  expect(
    warnings.filter(
      (message) => message.includes("rotation") && message.includes("one hour"),
    ),
  ).toHaveLength(1);
});

it.each(["initial", "batch"] as const)(
  "keeps sweeping and revokes late archived tokens when %s progress writes fail, warning once per failure streak",
  async (failurePoint) => {
    const { directory, hosts, tokens } = await fixture(96);
    const warnings: string[] = [];
    const store = new ThreadTokenStore(
      directory,
      hosts,
      Date.now,
      undefined,
      5000,
      (message) => warnings.push(message),
    );
    await store.initialize(["host-one"]);
    const rename = fs.rename.bind(fs);
    let writes = 0;
    let writable = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.basename(String(target)) === "thread-sweep.json") {
        writes += 1;
        if (!writable && (failurePoint === "initial" || writes > 1))
          throw Object.assign(new Error("progress write unavailable"), {
            code: "ENOSPC",
          });
      }
      return rename(source, target);
    });
    const checked = new Set<string>();
    await store.sweepThreads(async (id) => {
      checked.add(id);
      return id === "thr_0095" ? "archived" : "live";
    });
    expect(checked.size).toBe(96);
    expect(await store.authenticate(tokens.get("thr_0095") ?? "")).toBeNull();
    await store.sweepThreads(async () => "live");
    expect(
      warnings.filter((message) => message.includes("save sweep progress")),
    ).toHaveLength(1);
    writable = true;
    await store.sweepThreads(async () => "live");
    writable = false;
    await store.sweepThreads(async () => "live");
    expect(
      warnings.filter((message) => message.includes("save sweep progress")),
    ).toHaveLength(2);
  },
);

it("starts a fresh rotation and warns when the progress path cannot be read", async () => {
  const { directory, hosts, tokens } = await fixture(96);
  await fs.mkdir(path.join(directory, "thread-sweep.json"));
  const warnings: string[] = [];
  const restarted = new ThreadTokenStore(
    directory,
    hosts,
    Date.now,
    undefined,
    5000,
    (message) => warnings.push(message),
  );
  await restarted.initialize(["host-one"]);
  expect(
    warnings.some((message) => message.includes("read sweep progress")),
  ).toBe(true);
  await fs.rmdir(path.join(directory, "thread-sweep.json"));
  const result = await restarted.sweepThreads(async (id) =>
    id === "thr_0095" ? "archived" : "live",
  );
  expect(result.checked).toBe(96);
  expect(await restarted.authenticate(tokens.get("thr_0095") ?? "")).toBeNull();
});

it("rechecks failed archive persistence before advancing a rotation after restart and completes revocation", async () => {
  const { directory, hosts, store, tokens } = await fixture(96);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    const name = path.basename(String(target));
    if (
      name.startsWith("archived-thread-") ||
      name.startsWith("archive-revocation-")
    )
      throw Object.assign(new Error("archive write unavailable"), {
        code: "EROFS",
      });
    return rename(source, target);
  });
  const budget = new AbortController();
  let calls = 0;
  const first = await store.sweepThreads(
    async (id) => {
      calls += 1;
      if (calls > 64) {
        budget.abort();
        return new Promise(() => undefined);
      }
      return id === "thr_0048" ? "archived" : "live";
    },
    { signal: budget.signal },
  );
  expect(first.failed).toBe(1);
  vi.restoreAllMocks();
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked: string[] = [];
  const second = await restarted.sweepThreads(async (id) => {
    checked.push(id);
    return id === "thr_0048" ? "archived" : "live";
  });
  expect(checked[0]).toBe("thr_0048");
  expect(second.failed).toBe(0);
  const again = new ThreadTokenStore(directory, hosts);
  await again.initialize(["host-one"]);
  expect(await again.authenticate(tokens.get("thr_0048") ?? "")).toBeNull();
});

it("retries an early failed lookup first after a later cutoff and restart, then persists its revocation", async () => {
  const { directory, hosts, store, tokens } = await fixture(96);
  const budget = new AbortController();
  let calls = 0;
  await store.sweepThreads(
    async (id) => {
      if (++calls > 64) {
        budget.abort();
        return new Promise(() => undefined);
      }
      if (id === "thr_0016") throw new Error("lookup unavailable");
      return "live";
    },
    { signal: budget.signal },
  );
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked: string[] = [];
  await restarted.sweepThreads(async (id) => {
    checked.push(id);
    return id === "thr_0016" ? "archived" : "live";
  });
  expect(checked[0]).toBe("thr_0016");
  const again = new ThreadTokenStore(directory, hosts);
  await again.initialize(["host-one"]);
  expect(await again.authenticate(tokens.get("thr_0016") ?? "")).toBeNull();
});

it("completes rotations and revokes threads below and above a permanent state failure without starving new lower IDs", async () => {
  const { directory, hosts, store, tokens } = await fixture(192);
  const failedId = "thr_0048";
  const archived = new Set([
    "thr_0000",
    "thr_0096",
    "thr_0191",
    "thr_0000_new",
  ]);
  const checked = new Set<string>();
  const hash = createHash("sha256").update(failedId).digest("hex");
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    const name = path.basename(String(target));
    if (
      name.includes(hash) &&
      (name.startsWith("archived-thread-") ||
        name.startsWith("archive-revocation-"))
    )
      throw Object.assign(new Error("archive unavailable"), { code: "EROFS" });
    return rename(source, target);
  });
  let completed = 0;
  for (let sweep = 0; sweep < 8; sweep += 1) {
    const budget = new AbortController();
    let calls = 0;
    let failedCalls = 0;
    await store.sweepThreads(
      async (id) => {
        if (++calls > 72) {
          budget.abort();
          return new Promise(() => undefined);
        }
        checked.add(id);
        if (id === failedId) failedCalls += 1;
        return id === failedId || archived.has(id) ? "archived" : "live";
      },
      { signal: budget.signal },
    );
    expect(failedCalls).toBe(1);
    if (sweep === 0)
      tokens.set(
        "thr_0000_new",
        await store.forThread(
          {
            hostId: "host-one",
            threadId: "thr_0000_new",
            provider: "claude",
            accountId: null,
          },
          await hosts.forHost("host-one"),
        ),
      );
    const state = JSON.parse(
      await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
    );
    if (state.rotation === null && ++completed === 2) break;
  }
  expect(completed).toBe(2);
  expect(checked.size).toBe(193);
  for (const [id, token] of tokens)
    if (id !== failedId)
      expect((await store.authenticate(token))?.threadId ?? null).toBe(
        archived.has(id) ? null : id,
      );
  expect(
    JSON.parse(
      await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
    ),
  ).toMatchObject({ rotation: null, retries: [{ threadId: failedId }] });
});

it("retains persisted retry IDs across restart while progress writes fail", async () => {
  const { directory, hosts, store, tokens } = await fixture(96);
  const partial = async (target: ThreadTokenStore) => {
    const budget = new AbortController();
    let calls = 0;
    await target.sweepThreads(
      async (id) => {
        if (++calls > 64) {
          budget.abort();
          return new Promise(() => undefined);
        }
        if (id === "thr_0016") throw new Error("lookup unavailable");
        return "live";
      },
      { signal: budget.signal },
    );
  };
  await partial(store);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (path.basename(String(target)) === "thread-sweep.json")
      throw new Error("progress unavailable");
    return rename(source, target);
  });
  await partial(store);
  vi.restoreAllMocks();
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked: string[] = [];
  await restarted.sweepThreads(async (id) => {
    checked.push(id);
    return id === "thr_0016" ? "archived" : "live";
  });
  expect(checked[0]).toBe("thr_0016");
  expect(await restarted.authenticate(tokens.get("thr_0016") ?? "")).toBeNull();
});

it("bounds priority retry work to eight IDs per sweep and rotates failed IDs fairly across restarts", async () => {
  const { directory, hosts, store } = await fixture(96);
  await store.sweepThreads(async (id) => {
    if (id < "thr_0016") throw new Error("lookup unavailable");
    return "live";
  });
  const retried = new Set<string>();
  for (let sweep = 0; sweep < 2; sweep += 1) {
    const restarted = new ThreadTokenStore(directory, hosts);
    await restarted.initialize(["host-one"]);
    const failures: string[] = [];
    const live = new Set<string>();
    await restarted.sweepThreads(async (id) => {
      if (id < "thr_0016") {
        failures.push(id);
        throw new Error("lookup unavailable");
      }
      live.add(id);
      return "live";
    });
    expect(failures).toHaveLength(16);
    for (const id of failures.slice(0, 8)) retried.add(id);
    expect(new Set(failures).size).toBe(16);
    expect(live.size).toBe(80);
  }
  expect(retried.size).toBe(16);
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const budget = new AbortController();
  budget.abort();
  const lookup = vi.fn(async () => "live" as const);
  expect(
    await restarted.sweepThreads(lookup, { signal: budget.signal }),
  ).toEqual({ checked: 0, revoked: 0, failed: 0, deferred: 96 });
  expect(lookup).not.toHaveBeenCalled();
});

it("prunes orphan retry IDs after route removal and restart while retaining active failures", async () => {
  const { directory, hosts, store } = await fixture(16);
  await store.sweepThreads(async (id) => {
    if (id === "thr_0002" || id === "thr_0003")
      throw new Error("lookup unavailable");
    return "live";
  });
  await store.removeThread("thr_0002");
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked: string[] = [];
  await restarted.sweepThreads(async (id) => {
    checked.push(id);
    if (id === "thr_0002" || id === "thr_0003")
      throw new Error("lookup unavailable");
    return "live";
  });
  const state = JSON.parse(
    await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
  );
  expect(checked).not.toContain("thr_0002");
  expect(state.retries).toEqual([
    expect.objectContaining({ threadId: "thr_0003" }),
  ]);
});

it("caps durable retries at 256 while overflow remains covered by the main rotation after restart", async () => {
  const { directory, hosts, store, tokens } = await fixture(320);
  await store.sweepThreads(async () => {
    throw new Error("lookup unavailable");
  });
  const state = JSON.parse(
    await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
  );
  expect(state.retries).toHaveLength(256);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    const name = path.basename(String(target));
    if (
      name.startsWith("archived-thread-") ||
      name.startsWith("archive-revocation-")
    )
      throw new Error("archive persistence unavailable");
    return rename(source, target);
  });
  await store.sweepThreads(async (id) => {
    if (id === "thr_0319") return "archived";
    throw new Error("lookup unavailable");
  });
  vi.restoreAllMocks();
  const failed = JSON.parse(
    await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
  );
  expect(failed.retries).toHaveLength(256);
  expect(failed.retryOverflow).toBe(true);
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked = new Set<string>();
  await restarted.sweepThreads(async (id) => {
    checked.add(id);
    return id === "thr_0319" ? "archived" : "live";
  });
  expect(checked.size).toBe(320);
  for (const [id, token] of tokens)
    expect((await restarted.authenticate(token))?.threadId ?? null).toBe(
      id === "thr_0319" ? null : id,
    );
  const recovered = JSON.parse(
    await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
  );
  expect(recovered.retries).toEqual([]);
});

it("recovers 200 outage retries through the main rotation within four bounded sweeps", async () => {
  const { directory, hosts, store, tokens } = await fixture(200);
  await store.sweepThreads(async () => {
    throw new Error("lookup unavailable");
  });
  const checked = new Set<string>();
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const restarted = new ThreadTokenStore(directory, hosts);
    await restarted.initialize(["host-one"]);
    const budget = new AbortController();
    let calls = 0;
    await restarted.sweepThreads(
      async (id) => {
        if (++calls > 72) {
          budget.abort();
          return new Promise(() => undefined);
        }
        checked.add(id);
        return id === "thr_0199" ? "archived" : "live";
      },
      { signal: budget.signal },
    );
  }
  expect(checked.size).toBe(200);
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  for (const [id, token] of tokens)
    expect((await restarted.authenticate(token))?.threadId ?? null).toBe(
      id === "thr_0199" ? null : id,
    );
});

it("rechecks a failed thread after a crash loses the retry write before its atomic commit", async () => {
  const { directory, hosts, store, tokens } = await fixture(96);
  const budget = new AbortController();
  const rename = fs.rename.bind(fs);
  let lost = false;
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (path.basename(String(target)) === "thread-sweep.json") {
      const state = JSON.parse(await fs.readFile(source, "utf8"));
      if (
        state.retries.some(
          (entry: { threadId: string }) => entry.threadId === "thr_0016",
        )
      ) {
        lost = true;
        budget.abort();
        throw new Error("crash before progress rename");
      }
    }
    return rename(source, target);
  });
  await store.sweepThreads(
    async (id) => {
      if (id === "thr_0016") throw new Error("lookup unavailable");
      return "live";
    },
    { signal: budget.signal },
  );
  expect(lost).toBe(true);
  vi.restoreAllMocks();
  const durable = JSON.parse(
    await fs.readFile(path.join(directory, "thread-sweep.json"), "utf8"),
  );
  expect(durable.rotation.nextThreadId <= "thr_0016").toBe(true);
  const restarted = new ThreadTokenStore(directory, hosts);
  await restarted.initialize(["host-one"]);
  const checked: string[] = [];
  await restarted.sweepThreads(async (id) => {
    checked.push(id);
    return id === "thr_0016" ? "archived" : "live";
  });
  expect(checked).toContain("thr_0016");
  expect(await restarted.authenticate(tokens.get("thr_0016") ?? "")).toBeNull();
});
