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
    const enqueue = createDaemonSocketMessageQueue({
      afterOpen: () => afterOpen,
      handle: (message: () => void) => {
        message();
      },
      onError,
    });

    const output = enqueue(() => handled.push("terminal.output"));
    const exited = enqueue(() => handled.push("terminal.exited"));
    const sessions = enqueue(() => handled.push("sessions"));
    await Promise.resolve();
    expect(handled).toEqual([]);

    finishOpen();
    await Promise.all([output, exited, sessions]);

    expect(handled).toEqual([
      "terminal.output",
      "terminal.exited",
      "sessions",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });
});
