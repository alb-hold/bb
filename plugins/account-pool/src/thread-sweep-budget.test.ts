import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const directories: string[] = [];
afterEach(async () => {
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
  return { store, tokens };
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

it("defers budget cutoffs without lookup failures and resumes after the last dispatched thread", async () => {
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
  expect(first).not.toContain(next);
}, 60000);
