import { afterEach, describe, expect, it, vi } from "vitest";

const { createSocketFactory, socket } = vi.hoisted(() => {
  const socket = {
    close: vi.fn(),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: { data: string }) => void) | undefined,
    onopen: undefined as (() => void) | undefined,
    send: vi.fn(),
  };
  const createSocketFactory = vi.fn(() => () => socket);
  return { createSocketFactory, socket };
});

vi.mock("@bb/sdk/node-websocket", () => ({
  createNodeWebsocketFactory: createSocketFactory,
}));

import { attachTerminal } from "../commands/terminal.js";

const stdinDescriptors = new Map<string, PropertyDescriptor | undefined>();
const stdoutDescriptors = new Map<string, PropertyDescriptor | undefined>();

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

describe("terminal attach", () => {
  it("reports visible when the websocket opens", async () => {
    defineTerminalProperty(process.stdin, stdinDescriptors, "isTTY", true);
    defineTerminalProperty(process.stdout, stdoutDescriptors, "isTTY", true);
    defineTerminalProperty(process.stdin, stdinDescriptors, "isRaw", false);
    defineTerminalProperty(process.stdin, stdinDescriptors, "setRawMode", vi.fn());
    defineTerminalProperty(process.stdin, stdinDescriptors, "resume", vi.fn());
    defineTerminalProperty(process.stdin, stdinDescriptors, "pause", vi.fn());
    defineTerminalProperty(process.stdout, stdoutDescriptors, "columns", 80);
    defineTerminalProperty(process.stdout, stdoutDescriptors, "rows", 24);

    const attached = attachTerminal({
      baseUrl: "http://localhost:3001",
      terminalId: "term-1",
    });
    socket.onopen?.();

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "visibility", visible: true }),
    );

    socket.onclose?.();
    await attached;
  });
});
