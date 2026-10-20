import { describe, expect, it, vi } from "vitest";
import { createDaemonSocketMessageQueue } from "./daemon-protocol.js";

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
    await Promise.resolve();

    expect(handled).toEqual([
      "terminal.output",
      "terminal.exited",
      "sessions",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("handles messages synchronously after the open queue drains", async () => {
    const handled: string[] = [];
    const queue = createDaemonSocketMessageQueue({
      handle: (message: () => void) => message(),
      onError: (error) => {
        throw error;
      },
    });
    queue.enqueue(() => handled.push("queued"));
    queue.release();
    expect(handled).toEqual(["queued"]);

    queue.enqueue(() => handled.push("direct"));
    expect(handled).toEqual(["queued", "direct"]);
  });
});
