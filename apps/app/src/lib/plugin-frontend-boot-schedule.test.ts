import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestBrowserIdle,
  scheduleDeferredPluginFrontendBoot,
  whenHomeComposerInputOrTimeout,
} from "./plugin-frontend-boot-schedule";

describe("whenHomeComposerInputOrTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup(pathname = "/", mounted = true) {
    vi.useFakeTimers();
    const composer = new EventTarget();
    vi.stubGlobal("window", {
      location: { pathname },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", {
      querySelector: () => mounted ? composer : null,
    });
    return composer;
  }

  it("holds deferred boot until input and clears its fallback", async () => {
    const composer = setup();
    const ready = vi.fn();
    void whenHomeComposerInputOrTimeout().then(ready);
    await vi.advanceTimersByTimeAsync(1_999);
    composer.dispatchEvent(new Event("focus"));
    expect(ready).not.toHaveBeenCalled();
    composer.dispatchEvent(new Event("input"));
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases after two seconds without input and removes its listener", async () => {
    const composer = setup();
    const remove = vi.spyOn(composer, "removeEventListener");
    const ready = vi.fn();
    void whenHomeComposerInputOrTimeout().then(ready);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ready).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("input", expect.any(Function));
    composer.dispatchEvent(new Event("input"));
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
  });

  it.each([
    { path: "/threads/thread", mounted: true },
    { path: "/", mounted: false },
  ])("does not delay $path with mounted=$mounted", async ({ path, mounted }) => {
    setup(path, mounted);
    await whenHomeComposerInputOrTimeout();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function makeHarness() {
  let resolvePainted: () => void = () => {};
  const painted = new Promise<void>((resolve) => {
    resolvePainted = resolve;
  });
  const idleCallbacks: Array<() => void> = [];
  const cancelIdle = vi.fn();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const boot = vi.fn();
  const cancel = scheduleDeferredPluginFrontendBoot(boot, {
    whenRoutePainted: () => painted,
    requestIdle: (callback) => {
      idleCallbacks.push(callback);
      return cancelIdle;
    },
    setTimeout: (callback, _ms) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    timeoutMs: 1_500,
  });
  return {
    boot,
    cancel,
    cancelIdle,
    idleCallbacks,
    timers,
    paint: () => {
      resolvePainted();
      return Promise.resolve();
    },
    fireTimeout: () => {
      for (const callback of [...timers.values()]) callback();
    },
  };
}

describe("scheduleDeferredPluginFrontendBoot", () => {
  it("waits for route paint and then idle before booting, and drops the timeout", async () => {
    const h = makeHarness();
    expect(h.boot).not.toHaveBeenCalled();
    expect(h.idleCallbacks).toHaveLength(0);

    await h.paint();
    expect(h.boot).not.toHaveBeenCalled();
    expect(h.idleCallbacks).toHaveLength(1);

    h.idleCallbacks[0]!();
    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(0);
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("boots at the timeout when the route never paints, and ignores a later paint", async () => {
    const h = makeHarness();
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);

    await h.paint();
    expect(h.idleCallbacks).toHaveLength(0);
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("boots at the timeout when idle never comes after paint, and cancels the idle request", async () => {
    const h = makeHarness();
    await h.paint();
    expect(h.idleCallbacks).toHaveLength(1);
    h.fireTimeout();
    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.cancelIdle).toHaveBeenCalledTimes(1);
    h.idleCallbacks[0]!();
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents boot from every path", async () => {
    const h = makeHarness();
    h.cancel();
    expect(h.timers.size).toBe(0);
    await h.paint();
    expect(h.idleCallbacks).toHaveLength(0);
    h.fireTimeout();
    expect(h.boot).not.toHaveBeenCalled();
  });
});

describe("requestBrowserIdle fallback", () => {
  it("runs once by timeout when animation frames never fire", () => {
    let timeout = () => {};
    const clearTimeout = vi.fn();
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame: () => 7,
      cancelAnimationFrame,
      setTimeout: (callback: () => void) => {
        timeout = callback;
        return 3;
      },
      clearTimeout,
    });
    try {
      const run = vi.fn();
      requestBrowserIdle(run);
      timeout();
      timeout();
      expect(run).toHaveBeenCalledOnce();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
      expect(clearTimeout).toHaveBeenCalledWith(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
