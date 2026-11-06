import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, vi } from "vitest";
import {
  waitForReadiness,
  waitForReadinessCondition,
} from "./ThreadTerminalView.terminal-focus-test-utils";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";

export const testState = {
  sockets: [] as TestTerminalSocket[],
  socketMessages: [] as string[],
};

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

export function renderTerminal(status: "running" | "exited") {
  prepareTerminalDom();
  const onProgressChange =
    vi.fn<
      (progress: number | null, outputSeq?: number, terminalId?: string) => void
    >();
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

export async function mountTerminal(status: "running" | "exited") {
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

export function ackedThrough(nextSeq: number): void {
  expect(
    testState.socketMessages.map((message) => JSON.parse(message)),
  ).toContainEqual({ type: "ack", nextSeq });
}
