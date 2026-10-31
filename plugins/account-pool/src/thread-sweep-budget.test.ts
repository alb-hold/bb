import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(count = 3000) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "pool-sweep-budget-"));
  directories.push(directory);
  const hosts = new HubTokenStore(directory);
  await hosts.initialize();
  const hostToken = await hosts.forHost("host-one");
  const store = new ThreadTokenStore(directory, hosts);
  await store.initialize(["host-one"]);
  const tokens = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    const threadId = `thr_${String(i).padStart(4, "0")}`;
    tokens.set(
      threadId,
      await store.forThread(
        { hostId: "host-one", threadId, provider: "claude", accountId: null },
        hostToken,
      ),
    );
  }
  return { store, tokens, directory, hosts };
}

it.each([2697, 3000])(
  "checks every one of %i routed threads inside the production budget without a full-sweep abort or retry",
  async (count) => {
    const { store, tokens } = await fixture(count);
    let calls = 0;
    let active = 0;
    let peak = 0;
    const signal = AbortSignal.timeout(15000);
    const started = performance.now();
    const result = await store.sweepThreads(
      async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return "live";
      },
      { signal, lookupTimeoutMs: 5000 },
    );
    const elapsed = performance.now() - started;
    expect(result.failed).toBe(0);
    expect(calls).toBe(tokens.size);
    expect(signal.aborted).toBe(false);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    console.log(
      `sweep routes=${count} threads.get=${calls} elapsed_ms=${elapsed.toFixed(1)} steady_calls_per_minute=${((calls * 60000) / (900000 + elapsed)).toFixed(2)}`,
    );
  },
  60000,
);

it("revokes every missed archived thread beyond the old cutoff in one sweep, omits suspended routes from later sweeps, and preserves undo", async () => {
  const { store, tokens } = await fixture();
  const archived = [...tokens.keys()].slice(-100);
  await store.sweepThreads(
    async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return archived.includes(id) ? "archived" : "live";
    },
    { signal: AbortSignal.timeout(15000), lookupTimeoutMs: 5000 },
  );
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
