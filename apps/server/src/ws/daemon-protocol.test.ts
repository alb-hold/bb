import { describe, expect, it, vi } from "vitest";
import {
  createDaemonSocketMessageQueue,
  enqueueDaemonSocketFrame,
  isDaemonSocketMessageQueuePriority,
} from "./daemon-protocol.js";

describe("daemon socket message queue", () => {
  it("holds output, exit, and session messages until reconnect reconciliation finishes, preserving arrival order", async () => {
    let finishOpen!: () => void;
    const afterOpen = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const handled: string[] = [];
    const onError = vi.fn();
    const queue = createDaemonSocketMessageQueue({
      handle: (message: () => void) => {
        message();
      },
      onError,
    });
    void afterOpen.then(queue.release);

    queue.enqueue(() => handled.push("terminal.output"));
    queue.enqueue(() => handled.push("terminal.exited"));
    queue.enqueue(() => handled.push("sessions"));
    expect(handled).toEqual([]);

    finishOpen();
    await afterOpen;
    await new Promise((resolve) => setImmediate(resolve));

    expect(handled).toEqual(["terminal.output", "terminal.exited", "sessions"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("serializes asynchronous messages after the open queue drains", async () => {
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: (message: () => void) => message(),
      onError: (error) => {
        throw error;
      },
    });
    queue.enqueue(() => handled.push("queued"));
    queue.release();
    queue.enqueue(() => handled.push("direct"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual(["queued", "direct"]);
  });

  it("waits for each asynchronous message before delivering the next", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: async (message: () => void | Promise<void>) => {
        handled.push("start");
        await message();
        handled.push("finish");
      },
      onError: (error) => {
        throw error;
      },
    });
    queue.release();
    queue.enqueue(() => first);
    queue.enqueue(() => {
      handled.push("next");
    });
    await Promise.resolve();
    expect(handled).toEqual(["start"]);

    finishFirst();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual(["start", "finish", "start", "next", "finish"]);
  });

  it("keeps host RPC responses behind earlier socket messages while replay yields", async () => {
    let finishReplay!: () => void;
    const replay = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: async (message: { name: string; wait?: Promise<void> }) => {
        handled.push(message.name);
        await message.wait;
      },
      onError: (error) => {
        throw error;
      },
    });
    queue.release();
    queue.enqueue({ name: "terminal.replay", wait: replay });
    queue.enqueue(
      { name: "heartbeat" },
      isDaemonSocketMessageQueuePriority({ type: "heartbeat" }),
    );
    queue.enqueue(
      { name: "terminal.output" },
      isDaemonSocketMessageQueuePriority({ type: "terminal.output" }),
    );
    queue.enqueue(
      { name: "host-rpc.response" },
      isDaemonSocketMessageQueuePriority({ type: "host-rpc.response" }),
    );

    expect(handled).toEqual(["terminal.replay", "heartbeat"]);
    finishReplay();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual([
      "terminal.replay",
      "heartbeat",
      "terminal.output",
      "host-rpc.response",
    ]);
  });

  it("decodes each frame once and passes heartbeat priority to the queue", () => {
    const socket = { close: vi.fn(), send: vi.fn() };
    const decode = vi.fn(() => ({ type: "heartbeat" }) as never);
    const order: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: (message: { type: string }) => {
        order.push(`handled:${message.type}`);
      },
      onError: vi.fn(),
    });
    queue.release();
    enqueueDaemonSocketFrame({
      authorize: () => {
        order.push("authorized");
        return true;
      },
      decode,
      enqueue: (message, priority) => {
        order.push(`queued:${priority}`);
        queue.enqueue(message, priority);
      },
      raw: "frame",
      recordActivity: () => order.push("activity"),
      socket,
    });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "authorized",
      "activity",
      "queued:true",
      "handled:heartbeat",
    ]);
  });

  it("does not record activity or enqueue a rejected arrival", () => {
    const socket = { close: vi.fn(), send: vi.fn() };
    const decode = vi.fn(() => ({ type: "heartbeat" }) as never);
    const enqueue = vi.fn();
    const recordActivity = vi.fn();

    enqueueDaemonSocketFrame({
      authorize: () => false,
      decode,
      enqueue,
      raw: "frame",
      recordActivity,
      socket,
    });

    expect(decode).toHaveBeenCalledTimes(1);
    expect(recordActivity).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("continues draining when its error logger throws", async () => {
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: (message: string) => {
        if (message === "throws") throw new Error("handler failure");
        handled.push(message);
      },
      onError: () => {
        throw new Error("logger failure");
      },
    });
    queue.release();
    queue.enqueue("throws");
    queue.enqueue("continues");
    expect(handled).toEqual(["continues"]);
  });

  it("drains messages accepted before socket close in arrival order", async () => {
    let finishReplay!: () => void;
    const replay = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: async (message: { name: string; wait?: Promise<void> }) => {
        handled.push(message.name);
        await message.wait;
      },
      onError: () => undefined,
    });
    queue.release();
    queue.enqueue({ name: "replay", wait: replay });
    queue.enqueue({ name: "terminal.exited" });
    queue.close();
    expect(handled).toEqual(["replay"]);
    finishReplay();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual(["replay", "terminal.exited"]);
  });
});
