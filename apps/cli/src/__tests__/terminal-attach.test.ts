import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalClientMessageSchema } from "@bb/server-contract";
import { NotificationHub } from "../../../server/src/ws/hub.js";

const { socket } = vi.hoisted(() => {
  const socket = {
    addEventListener: vi.fn<(type: string, listener: EventListener) => void>(),
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

  it("reclaims the real shared PTY on CLI input without resizing again for repeat input", async () => {
    prepareInteractiveTerminal(120, 40);
    const ownerChanged = vi.fn();
    const hub = new NotificationHub(ownerChanged);
    const terminalId = "term-cli-reclaim";
    const cli = { close: () => {}, send: () => {} };
    const phone = { close: () => {}, send: () => {} };
    const received: Array<{
      input: string;
      size: { cols: number; rows: number } | null;
    }> = [];
    hub.registerTerminalClient(terminalId, cli);
    hub.registerTerminalClient(terminalId, phone);
    socket.send.mockImplementation((payload: string) => {
      const message = terminalClientMessageSchema.parse(JSON.parse(payload));
      if (message.type === "resize") {
        hub.recordTerminalClientSize(
          terminalId,
          cli,
          { cols: message.cols, rows: message.rows },
          Date.now(),
          message.claim === true,
        );
      } else if (message.type === "visibility") {
        hub.recordTerminalClientVisibility(
          terminalId,
          cli,
          message.visible,
          Date.now(),
        );
      } else if (message.type === "input") {
        received.push({
          input: Buffer.from(message.dataBase64, "base64").toString(),
          size: hub.terminalSharedSize(terminalId, Date.now()),
        });
      }
    });
    const attached = attachTerminal({
      baseUrl: "http://localhost:3001",
      terminalId,
    });
    try {
      openSocket();
      expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual({
        cols: 120,
        rows: 40,
      });
      hub.recordTerminalClientSize(
        terminalId,
        phone,
        { cols: 80, rows: 20 },
        Date.now(),
        true,
      );
      expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual({
        cols: 80,
        rows: 20,
      });

      process.stdin.emit("data", Buffer.from("a"));
      expect(received).toEqual([{ input: "a", size: { cols: 120, rows: 40 } }]);
      const ownershipChanges = ownerChanged.mock.calls.length;
      process.stdin.emit("data", Buffer.from("b"));
      expect(received).toEqual([
        { input: "a", size: { cols: 120, rows: 40 } },
        { input: "b", size: { cols: 120, rows: 40 } },
      ]);
      expect(ownerChanged).toHaveBeenCalledTimes(ownershipChanges);
      hub.recordTerminalClientSize(
        terminalId,
        phone,
        { cols: 75, rows: 18 },
        Date.now(),
      );
      expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual({
        cols: 120,
        rows: 40,
      });
      process.stdin.emit("data", Buffer.from([0x02]));
      process.stdin.emit("data", Buffer.from("d"));
      expect(socket.close).toHaveBeenCalledOnce();
      expect(received).toHaveLength(2);
    } finally {
      socket.onclose?.();
      await attached;
      hub.unregisterTerminalClient(terminalId, cli);
      hub.unregisterTerminalClient(terminalId, phone);
    }
  });
});
