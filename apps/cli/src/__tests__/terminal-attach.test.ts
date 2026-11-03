import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalClientMessageSchema } from "@bb/server-contract";

const { socket } = vi.hoisted(() => {
  const socket = {
    addEventListener: vi.fn<(type: string, listener: EventListener) => void>(),
    bufferedAmount: 0,
    close: vi.fn(),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: { data: string }) => void) | undefined,
    onopen: undefined as (() => void) | undefined,
    readyState: 1,
    send: vi.fn(),
  };
  return { socket };
});

import { attachTerminal } from "../commands/terminal.js";

const stdinDescriptors = new Map<string, PropertyDescriptor | undefined>();
const stdoutDescriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  socket.bufferedAmount = 0;
  socket.send.mockReset();
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return socket;
    }),
  );
});

afterEach(() => {
  for (const [key, descriptor] of stdinDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdin, key);
    else Object.defineProperty(process.stdin, key, descriptor);
  }
  for (const [key, descriptor] of stdoutDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdout, key);
    else Object.defineProperty(process.stdout, key, descriptor);
  }
  stdinDescriptors.clear();
  stdoutDescriptors.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function defineTerminalProperty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  descriptors: Map<string, PropertyDescriptor | undefined>,
  key: string,
  value: unknown,
): void {
  descriptors.set(key, Object.getOwnPropertyDescriptor(stream, key));
  Object.defineProperty(stream, key, { configurable: true, value });
}

function prepareInteractiveTerminal(cols = 80, rows = 24) {
  defineTerminalProperty(process.stdin, stdinDescriptors, "isTTY", true);
  defineTerminalProperty(process.stdout, stdoutDescriptors, "isTTY", true);
  defineTerminalProperty(process.stdin, stdinDescriptors, "isRaw", false);
  defineTerminalProperty(
    process.stdin,
    stdinDescriptors,
    "setRawMode",
    vi.fn(),
  );
  defineTerminalProperty(process.stdin, stdinDescriptors, "resume", vi.fn());
  defineTerminalProperty(process.stdin, stdinDescriptors, "pause", vi.fn());
  defineTerminalProperty(process.stdout, stdoutDescriptors, "columns", cols);
  defineTerminalProperty(process.stdout, stdoutDescriptors, "rows", rows);
}

function openSocket() {
  for (const [type, listener] of socket.addEventListener.mock.calls) {
    if (type === "open") listener(new Event("open"));
  }
  socket.onopen?.();
}

describe("terminal attach", () => {
  it("reports visible, displays output and restores raw mode on close", async () => {
    prepareInteractiveTerminal();

    const attached = attachTerminal({
      baseUrl: "http://localhost:3001",
      terminalId: "term-1",
    });
    openSocket();

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "visibility", visible: true }),
    );

    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("terminal output").toString("base64"),
        },
      }),
    });
    expect(output).toHaveBeenCalledWith(Buffer.from("terminal output"));

    socket.onclose?.();
    await attached;
    expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "claims the terminal size immediately before delivering CLI input (queued=%s)",
    async (queued) => {
      if (queued) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      prepareInteractiveTerminal(120, 40);
      const terminalId = "term-cli-reclaim";
      const messages: Array<
        ReturnType<typeof terminalClientMessageSchema.parse>
      > = [];
      const claim = { type: "resize", cols: 120, rows: 40, claim: true };
      socket.send.mockImplementation((payload: string) => {
        messages.push(terminalClientMessageSchema.parse(JSON.parse(payload)));
      });
      const attached = attachTerminal({
        baseUrl: "http://localhost:3001",
        terminalId,
      });
      try {
        openSocket();
        expect(messages).toContainEqual(claim);
        messages.length = 0;

        if (queued) socket.bufferedAmount = 2 * 1024 * 1024;
        process.stdin.emit("data", Buffer.from("a"));
        if (queued) {
          expect(messages.some((message) => message.type === "input")).toBe(
            false,
          );
          messages.length = 0;
          socket.bufferedAmount = 0;
          await vi.advanceTimersByTimeAsync(10);
        }
        expect(messages.slice(-2)).toEqual([
          claim,
          { type: "input", dataBase64: Buffer.from("a").toString("base64") },
        ]);
        process.stdin.emit("data", Buffer.from("b"));
        expect(messages.slice(-2)).toEqual([
          claim,
          { type: "input", dataBase64: Buffer.from("b").toString("base64") },
        ]);
        process.stdin.emit("data", Buffer.from([0x02]));
        process.stdin.emit("data", Buffer.from("d"));
        expect(socket.close).toHaveBeenCalledOnce();
        expect(messages.filter((message) => message.type === "input")).toEqual([
          { type: "input", dataBase64: Buffer.from("a").toString("base64") },
          { type: "input", dataBase64: Buffer.from("b").toString("base64") },
        ]);
      } finally {
        socket.onclose?.();
        await attached;
      }
    },
  );

  it("reports input backpressure instead of silently dropping a large paste", async () => {
    prepareInteractiveTerminal();
    const attached = attachTerminal({
      baseUrl: "http://localhost:3001",
      terminalId: "term-input-pressure",
    });
    const rejected = expect(attached).rejects.toThrow(
      "Terminal input queue is full",
    );
    openSocket();
    socket.bufferedAmount = 2 * 1024 * 1024;
    process.stdin.emit("data", Buffer.alloc(2 * 1024 * 1024));
    await rejected;
    expect(socket.close).toHaveBeenCalledOnce();
    expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it("rejects socket construction failures and restores terminal mode", async () => {
    prepareInteractiveTerminal();
    const failure = new Error("WebSocket construction failed");
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw failure;
        }
      },
    );
    await expect(
      attachTerminal({
        baseUrl: "http://localhost:3001",
        terminalId: "term-connection-failure",
      }),
    ).rejects.toBe(failure);
    expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });
});
