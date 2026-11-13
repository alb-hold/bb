import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemotePreferenceSignal,
  attachPreferencesStore,
  flushPreferenceWritesForTest,
  hydratePreferences,
  hydratePreferencesFromMirror,
  loadPreferencesUntilReady,
  preferencesMirrorStorageKey,
  preferencesReadyAtom,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
  type PreferencesRpc,
} from "./preferences-sync.js";
import { createSyncedPreferenceAtom } from "./synced-preference-atom.js";
import { defaultPreferences } from "../../shared/preferences.js";

function fakeRpc(
  preferences: Record<string, unknown> = {},
): PreferencesRpc & { calls: { method: string; input: unknown }[] } {
  const calls: { method: string; input: unknown }[] = [];
  return {
    calls,
    async call(method: string, input: unknown) {
      calls.push({ method, input });
      if (method === "listPreferences") {
        return { preferences: { ...defaultPreferences(), ...preferences } };
      }
      return input;
    },
  };
}

function deferredRpc(): PreferencesRpc & {
  writes: { key: string; value: unknown; origin: string }[];
  settleNextWrite: () => Promise<void>;
} {
  const writes: { key: string; value: unknown; origin: string }[] = [];
  const settlers: (() => void)[] = [];
  return {
    writes,
    async settleNextWrite() {
      settlers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    },
    async call(method: string, input: unknown) {
      if (method === "listPreferences") {
        return { preferences: defaultPreferences() };
      }
      writes.push(input as { key: string; value: unknown; origin: string });
      return new Promise((resolve) => settlers.push(() => resolve(input)));
    },
  };
}

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() {
      return rows.size;
    },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => {
      rows.delete(key);
    },
    setItem: (key, value) => {
      rows.set(key, String(value));
    },
  };
}

const MIRROR_KEY = preferencesMirrorStorageKey("thread-list");

let mirror: Storage;

beforeEach(() => {
  vi.useFakeTimers();
  mirror = memoryStorage();
  setPreferencesMirrorStorageForTest(mirror);
  attachPreferencesStore(getDefaultStore(), "thread-list");
});

afterEach(() => {
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  vi.useRealTimers();
});

describe("preferences sync", () => {
  it("hydrates from the server, marks ready, and mirrors to localStorage", async () => {
    const store = getDefaultStore();
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    expect(store.get(preferencesReadyAtom())).toBe(false);
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));
    expect(store.get(preferencesReadyAtom())).toBe(true);
    expect(store.get(modeAtom)).toBe("machine");
    expect(
      JSON.parse(mirror.getItem(MIRROR_KEY) ?? "{}").organizationMode,
    ).toBe("machine");
  });

  it("paints from the mirror before the server answers and ignores junk in it", () => {
    mirror.setItem(
      MIRROR_KEY,
      JSON.stringify({
        organizationMode: "project",
        chronologicalSort: "nonsense",
      }),
    );
    const store = getDefaultStore();
    expect(hydratePreferencesFromMirror()).toBe(true);
    expect(store.get(createSyncedPreferenceAtom("organizationMode"))).toBe(
      "project",
    );
    expect(store.get(createSyncedPreferenceAtom("chronologicalSort"))).toBe(
      "updated",
    );
    mirror.setItem(MIRROR_KEY, "{not json");
    expect(hydratePreferencesFromMirror()).toBe(false);
  });

  it("keys the mirror by plugin id, so a renamed copy keeps its own layout", async () => {
    expect(MIRROR_KEY).toBe("bb.thread-list.preferences.v1");
    mirror.setItem(MIRROR_KEY, JSON.stringify({ organizationMode: "project" }));
    attachPreferencesStore(getDefaultStore(), "my-sidebar");

    expect(hydratePreferencesFromMirror()).toBe(false);
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));

    expect(
      JSON.parse(mirror.getItem("bb.my-sidebar.preferences.v1") ?? "{}")
        .organizationMode,
    ).toBe("machine");
    expect(
      JSON.parse(mirror.getItem(MIRROR_KEY) ?? "{}").organizationMode,
    ).toBe("project");
  });

  it("applies a local write immediately and coalesces the server write", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");
    store.set(collapsedAtom, ["proj_a"]);
    store.set(collapsedAtom, (current) => [...current, "proj_b"]);
    store.set(collapsedAtom, (current) =>
      current.filter((id) => id !== "proj_a"),
    );
    expect(store.get(collapsedAtom)).toEqual(["proj_b"]);
    expect(
      rpc.calls.filter((call) => call.method === "setPreference"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(rpc.calls.filter((call) => call.method === "setPreference")).toEqual(
      [
        {
          method: "setPreference",
          input: {
            key: "collapsedProjects",
            value: ["proj_b"],
            origin: expect.any(String),
          },
        },
      ],
    );
  });

  it("takes a remote change from another window unless a local write is pending", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const sortAtom = createSyncedPreferenceAtom("chronologicalSort");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "alpha",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "bogus",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");
    applyRemotePreferenceSignal({
      key: "nope",
      value: 1,
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("alpha");

    store.set(sortAtom, "created");
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "updated",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("created");
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    applyRemotePreferenceSignal({
      key: "chronologicalSort",
      value: "updated",
      origin: "other-window",
    });
    expect(store.get(sortAtom)).toBe("updated");
  });

  it("ignores the late echo of its own earlier write after the user toggles again", async () => {
    const rpc = deferredRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");
    const seen: string[][] = [];
    store.sub(collapsedAtom, () => seen.push(store.get(collapsedAtom)));

    store.set(collapsedAtom, ["proj_a"]);
    vi.advanceTimersByTime(150);
    await rpc.settleNextWrite();
    store.set(collapsedAtom, []);
    vi.advanceTimersByTime(150);
    await rpc.settleNextWrite();
    for (const write of rpc.writes) {
      applyRemotePreferenceSignal(write);
    }

    expect(seen).toEqual([["proj_a"], []]);
    expect(store.get(collapsedAtom)).toEqual([]);
  });

  it("sends one write per key at a time and follows up with the latest value", async () => {
    const rpc = deferredRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const collapsedAtom = createSyncedPreferenceAtom("collapsedProjects");

    store.set(collapsedAtom, ["proj_a"]);
    vi.advanceTimersByTime(150);
    store.set(collapsedAtom, []);
    vi.advanceTimersByTime(150);
    expect(rpc.writes.map((write) => write.value)).toEqual([["proj_a"]]);

    await rpc.settleNextWrite();
    expect(rpc.writes.map((write) => write.value)).toEqual([["proj_a"], []]);
    applyRemotePreferenceSignal({
      key: "collapsedProjects",
      value: ["proj_b"],
      origin: "other-window",
    });
    expect(store.get(collapsedAtom)).toEqual([]);

    await rpc.settleNextWrite();
    applyRemotePreferenceSignal({
      key: "collapsedProjects",
      value: ["proj_b"],
      origin: "other-window",
    });
    expect(store.get(collapsedAtom)).toEqual(["proj_b"]);
  });

  it("does not write back a value that did not change", async () => {
    const rpc = fakeRpc();
    await hydratePreferences(rpc);
    const store = getDefaultStore();
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    store.set(modeAtom, "chronological");
    vi.advanceTimersByTime(200);
    await flushPreferenceWritesForTest();
    expect(
      rpc.calls.filter((call) => call.method === "setPreference"),
    ).toHaveLength(0);
  });
});

describe("preferences sync with a provided store", () => {
  it("reads and writes the attached store instead of the default one", async () => {
    const { createStore } = await import("jotai");
    const custom = createStore();
    attachPreferencesStore(custom, "thread-list");
    const modeAtom = createSyncedPreferenceAtom("organizationMode");
    await hydratePreferences(fakeRpc({ organizationMode: "machine" }));
    expect(custom.get(preferencesReadyAtom())).toBe(true);
    expect(custom.get(modeAtom)).toBe("machine");
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
  });
});

function flakyRpc(failures: number): PreferencesRpc & { loads: () => number } {
  let loads = 0;
  return {
    loads: () => loads,
    async call(method: string, input: unknown) {
      if (method !== "listPreferences") return input;
      loads += 1;
      if (loads <= failures) {
        throw new Error(
          'plugin "thread-list" is not running (status: starting)',
        );
      }
      return { preferences: defaultPreferences() };
    },
  };
}

describe("loading preferences at startup", () => {
  it("retries a failed load until the server answers, then marks ready", async () => {
    const store = getDefaultStore();
    const rpc = flakyRpc(2);
    const onError = vi.fn();
    loadPreferencesUntilReady(rpc, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.loads()).toBe(1);
    expect(store.get(preferencesReadyAtom())).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.loads()).toBe(2);
    expect(store.get(preferencesReadyAtom())).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc.loads()).toBe(3);
    expect(store.get(preferencesReadyAtom())).toBe(true);
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.loads()).toBe(3);
  });

  it("keeps retrying at the last delay while the load keeps failing", async () => {
    const rpc = flakyRpc(Number.POSITIVE_INFINITY);
    loadPreferencesUntilReady(rpc, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(rpc.loads()).toBe(4);
    await vi.advanceTimersByTimeAsync(5_000 * 10);
    expect(rpc.loads()).toBe(14);
    expect(getDefaultStore().get(preferencesReadyAtom())).toBe(false);
  });

  it("stops retrying once cancelled", async () => {
    const rpc = flakyRpc(Number.POSITIVE_INFINITY);
    const cancel = loadPreferencesUntilReady(rpc, () => {});
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc.loads()).toBe(1);
  });
});
