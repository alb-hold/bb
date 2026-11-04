import { describe, expect, it } from "vitest";
import { PendingRpcRegistry } from "./pending-rpc-registry.js";

describe("PendingRpcRegistry", () => {
  it("re-arms consecutive late attach timeouts within the bounded window", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 90));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    };
    await stall();
    await stall();
    expect(registry.settle("attach", { value: "replayed" })).toBe(true);
    await expect(pending.promise).resolves.toEqual({ value: "replayed" });
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
});
