// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitForReadiness,
  waitForReadinessCondition,
} from "./ThreadTerminalView.terminal-focus-test-utils";
import { sdk } from "@/lib/sdk";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  sockets: [] as TestTerminalSocket[],
  socketMessages: [] as string[],
}));

class TestTerminalSocket {
  readonly protocol = "bb.terminal.resize-echo.v1";
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  bufferedAmount = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = TestTerminalSocket.CONNECTING;
  readonly opened: Promise<void>;
  private resolveOpened!: () => void;

  constructor(_url: string) {
    testState.sockets.push(this);
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
    queueMicrotask(() => this.open());
  }

  open(): void {
    this.readyState = TestTerminalSocket.OPEN;
    this.onopen?.(new Event("open"));
    this.resolveOpened();
  }

  close(): void {
    this.readyState = TestTerminalSocket.CLOSED;
  }

  disconnect(): void {
    this.readyState = TestTerminalSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent);
  }

  send(data: string): void {
    testState.socketMessages.push(data);
  }

  receive(message: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
}

vi.mock("@/lib/sdk", () => ({
  sdk: {
    terminals: {
      experimental_screen: vi.fn(),
      output: vi.fn(),
      experimental_attention: { clear: vi.fn() },
    },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn() },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { showKeyboardHints: false },
      keybindings: [],
    },
  }),
}));

vi.mock("@/hooks/usePluginCommandBindings", () => ({
  usePluginCommandBindings: () => ({
    commands: [],
    defaults: [],
    keybindings: [],
  }),
}));

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  testState.sockets.length = 0;
  testState.socketMessages.length = 0;
});

function prepareTerminalDom(): void {
  vi.stubGlobal("WebSocket", TestTerminalSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect(): void {}

      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 354, height: 504 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }

      unobserve(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 9 }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function offsetWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function offsetHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function clientWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 9 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function clientHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      return new DOMRect(0, 0, this.clientWidth, this.clientHeight);
    },
  );
}

function renderTerminal(status: "running" | "exited") {
  prepareTerminalDom();
  const onProgressChange = vi.fn<(progress: number | null) => void>();
  const session = makeTerminalSession({
    id: "term_progress_replay",
    status,
    cols: 40,
    rows: 12,
  });
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <ThreadTerminalView
          autoFocus={false}
          isPanelOpen
          onProgressChange={onProgressChange}
          session={session}
        />
      </AppCommandProvider>
    </MemoryRouter>,
  );
  return { onProgressChange, session };
}

async function mountTerminal(status: "running" | "exited") {
  const { onProgressChange, session } = renderTerminal(status);
  await waitForReadinessCondition(
    () => expect(testState.sockets).toHaveLength(1),
    "terminal socket was not created within 5000 ms",
  );
  const socket = testState.sockets[0];
  if (!socket) throw new Error("terminal socket is missing");
  await waitForReadiness(socket.opened, "terminal socket did not open");
  return { onProgressChange, session, socket };
}

function ackedThrough(nextSeq: number): void {
  expect(
    testState.socketMessages.map((message) => JSON.parse(message)),
  ).toContainEqual({ type: "ack", nextSeq });
}

const osc = (body: string) => btoa(`\x1b]9;4;${body}\x07`);

describe("ThreadTerminalView progress and replay", () => {
  it("does not re-apply replayed progress when a terminal is remounted, but applies live progress", async () => {
    const { onProgressChange, session, socket } = await mountTerminal(
      "running",
    );
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 3,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("working\r\n") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: osc("1;60") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("still working\r\n") },
    });
    await waitForReadinessCondition(
      () => ackedThrough(3),
      "replayed output was not acknowledged",
    );
    expect(onProgressChange).not.toHaveBeenCalled();

    socket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: osc("1;40") },
    });
    await waitForReadinessCondition(
      () => expect(onProgressChange).toHaveBeenLastCalledWith(0.4),
      "live progress was not applied",
    );
    socket.receive({
      type: "output",
      chunk: { seq: 4, dataBase64: osc("0") },
    });
    await waitForReadinessCondition(
      () => expect(onProgressChange).toHaveBeenLastCalledWith(null),
      "live progress clear was not applied",
    );
    expect(onProgressChange).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect progress from a replay after the terminal exited", async () => {
    vi.mocked(sdk.terminals.output).mockResolvedValue({
      chunks: [
        { seq: 0, dataBase64: osc("1;70") },
        { seq: 1, dataBase64: btoa("done\r\n") },
      ],
      nextSeq: 2,
    } as Awaited<ReturnType<typeof sdk.terminals.output>>);
    const { onProgressChange } = renderTerminal("exited");
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector(".xterm-rows")?.textContent ?? "",
        ).toContain("Terminal exited"),
      "retained output was not written within 5000 ms",
    );
    expect(onProgressChange).not.toHaveBeenCalled();
  });
});
