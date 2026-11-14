import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingRpcRegistry } from "./pending-rpc-registry.js";

async function stallEventLoop(blockedMs: number): Promise<void> {
  vi.setSystemTime(Date.now() + blockedMs);
  await vi.advanceTimersByTimeAsync(0);
}

describe("PendingRpcRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles replay delivered after two late timeout firings", async () => {
    vi.useFakeTimers();
    const registry = new PendingRpcRegistry<
      { rpcKey: string },
      { value: string }
    >({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 100,
    });
    const startedAt = Date.now();
    const pending = registry.claim({ rpcKey: "attach" });
    let rejected = false;
    pending.promise.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(70);
    await stallEventLoop(40);
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(70);
    await stallEventLoop(40);
    await vi.advanceTimersByTimeAsync(30);
    expect(Date.now() - startedAt).toBe(280);
    expect(rejected).toBe(false);
    expect(registry.settle("attach", { value: "replayed" })).toBe(true);
    await expect(pending.promise).resolves.toEqual({ value: "replayed" });
  });

  it("fails late timeout firings after three times the nominal deadline", async () => {
    const registry = new PendingRpcRegistry<{ rpcKey: string }, string>({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 100,
    });
    const pending = registry.claim({ rpcKey: "attach" });
    const stall = async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    };
    const result = expect(pending.promise).rejects.toThrow("timeout");
    await stall();
    await stall();
    await stall();
    await stall();
    await result;
  });

  it("fails an attach timeout that fires on time", async () => {
    const registry = new PendingRpcRegistry<{ rpcKey: string }, string>({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 10,
    });
    const pending = registry.claim({ rpcKey: "attach" });
    await expect(pending.promise).rejects.toThrow("timeout");
  });

  it("expires after a late firing followed by an on-time firing", async () => {
    vi.useFakeTimers();
    const registry = new PendingRpcRegistry<{ rpcKey: string }, string>({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 100,
    });
    const startedAt = Date.now();
    const pending = registry.claim({ rpcKey: "attach" });
    let rejectedAfterMs: number | null = null;
    const result = expect(pending.promise).rejects.toThrow("timeout");
    pending.promise.catch(() => {
      rejectedAfterMs = Date.now() - startedAt;
    });
    await vi.advanceTimersByTimeAsync(70);
    await stallEventLoop(40);
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(99);
    expect(rejectedAfterMs).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(rejectedAfterMs).toBe(240);
  });
});
