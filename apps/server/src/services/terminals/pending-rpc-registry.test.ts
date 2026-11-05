import { describe, expect, it } from "vitest";
import { PendingRpcRegistry } from "./pending-rpc-registry.js";

describe("PendingRpcRegistry", () => {
  it("settles replay delivered after two late timeout firings", async () => {
    const registry = new PendingRpcRegistry<
      { rpcKey: string },
      { value: string }
    >({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 100,
    });
    const pending = registry.claim({ rpcKey: "attach" });
    const stall = async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    };
    await stall();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stall();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settled = new Promise<boolean>((resolve) => {
      setImmediate(() => resolve(registry.settle("attach", { value: "replayed" })));
    });
    expect(await settled).toBe(true);
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
    const registry = new PendingRpcRegistry<{ rpcKey: string }, string>({
      lateTimeoutRetryMs: 5,
      timeoutError: () => new Error("timeout"),
      timeoutMs: 100,
    });
    const startedAt = Date.now();
    const pending = registry.claim({ rpcKey: "attach" });
    const result = expect(pending.promise).rejects.toThrow("timeout");
    await new Promise((resolve) => setTimeout(resolve, 70));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    await result;
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(190);
    expect(elapsedMs).toBeLessThan(300);
  });
});
