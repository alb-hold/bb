// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalScreenResponse } from "@bb/server-contract";
import { Terminal } from "@xterm/xterm";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitForReadiness,
  waitForReadinessCondition,
} from "./ThreadTerminalView.terminal-focus-test-utils";
import {
  REPAINT_RESTORE_DELAY_MS,
  TerminalWebSocketTransport,
} from "@bb/client-core";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import { applyAppThemeCss } from "@/lib/app-theme-css";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import * as terminalModules from "./terminal-modules";
import * as terminalReplayPreview from "./terminal-replay-preview";
import * as terminalViewport from "./terminal-viewport";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView, writeTerminalOutput } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
  setDefaultColors: vi.fn().mockResolvedValue({}),
  deferSocketOpen: false,
  mediaQueryListeners: new Set<() => void>(),
  touchEnabled: false,
  toastError: vi.fn(),
  sockets: [] as TestTerminalSocket[],
  socketCreated: null as (() => void) | null,
  socketMessages: [] as string[],
  socketUrls: [] as string[],
  screen: vi.fn(),
  output: vi.fn(),
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
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number }> = [];
  private resolveOpened!: () => void;

  constructor(url: string) {
    testState.socketUrls.push(url);
    testState.sockets.push(this);
    testState.socketCreated?.();
    testState.socketCreated = null;
    this.opened = new Promise((resolve) => {
      this.resolveOpened = resolve;
    });
    if (!testState.deferSocketOpen) {
      queueMicrotask(() => this.open());
    }
  }

  open(): void {
    this.readyState = TestTerminalSocket.OPEN;
    this.onopen?.(new Event("open"));
    this.resolveOpened();
  }

  close(code = 1000, reason = ""): void {
    if (
      code !== undefined &&
      code !== 1000 &&
      !(code >= 3000 && code <= 4999)
    ) {
      throw new DOMException(
        `The close code must be 1000 or in the range 3000-4999: ${code}`,
        "InvalidAccessError",
      );
    }
    if (new TextEncoder().encode(reason ?? "").byteLength > 123) {
      throw new DOMException("The close reason is too long", "SyntaxError");
    }
    this.closeCalls.push({ code });
    if (this.readyState === TestTerminalSocket.CLOSED) return;
    this.readyState = TestTerminalSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason } as CloseEvent));
  }

  disconnect(): void {
    this.readyState = TestTerminalSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test disconnect" } as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
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
      experimental_setDefaultColors: testState.setDefaultColors,
      experimental_screen: testState.screen,
      output: testState.output,
      experimental_attention: {
        clear: testState.clearAttention,
      },
    },
  },
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: testState.toastError },
}));

vi.mock("@bb/shared-ui/hooks/use-media-query", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const actual =
    await importOriginal<
      typeof import("@bb/shared-ui/hooks/use-media-query")
    >();
  return {
    ...actual,
    useMediaQuery: (query: string) => {
      const touchEnabled = useSyncExternalStore(
        (notify) => {
          testState.mediaQueryListeners.add(notify);
          return () => testState.mediaQueryListeners.delete(notify);
        },
        () => testState.touchEnabled,
        () => false,
      );
      const actualValue = actual.useMediaQuery(query);
      return query === "(pointer: coarse)" ? touchEnabled : actualValue;
    },
  };
});

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
    keybindings: [
      {
        command: "thread.search",
        desktopOnly: false,
        shortcut: {
          key: "k",
          mod: false,
          meta: false,
          control: true,
          alt: false,
          shift: false,
        },
        when: { all: ["mainSurface"], none: ["terminalFocus"] },
      },
    ],
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  applyAppThemeCss("");
  document.documentElement.style.removeProperty("--foreground");
  document.documentElement.style.removeProperty("--ink");
  document.documentElement.style.removeProperty("--sidebar");
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLStyleElement && !owner.isConnected) {
      document.head.append(owner);
      owner.remove();
    }
  }
  expect(
    Array.from(document.styleSheets).filter(
      (sheet) => sheet.ownerNode !== null && !sheet.ownerNode.isConnected,
    ),
  ).toEqual([]);
  sessionStorage.removeItem("bb:terminal-viewport:term_mobile_paste");
  Reflect.set(wsManager, "deviceHandoffClientToken", null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  }
  testState.calls.length = 0;
  testState.sockets.length = 0;
  testState.socketCreated = null;
  testState.deferSocketOpen = false;
  testState.socketMessages.length = 0;
  testState.socketUrls.length = 0;
  testState.clearAttention.mockReset();
  testState.screen.mockReset();
  testState.output.mockReset();
  testState.toastError.mockReset();
  testState.touchEnabled = false;
  testState.mediaQueryListeners.clear();
});

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

vi.setConfig({ testTimeout: 30_000 });

function prepareMobileTerminal(): void {
  testState.touchEnabled = true;
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (kind) =>
      kind === "2d"
        ? ({
            measureText: (text: string) => ({ width: text.length * 9 }),
          } as unknown as CanvasRenderingContext2D)
        : null,
  );
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

function prepareFirstAttachFontMetricsHarness(): void {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches:
      query === COMPACT_VIEWPORT_QUERY
        ? window.innerWidth <= 767
        : matchMedia(query).matches,
  }));
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (kind) =>
      kind === "2d"
        ? ({
            measureText: (text: string) => ({ width: text.length * 7 }),
          } as unknown as CanvasRenderingContext2D)
        : null,
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function offsetWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 7 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function offsetHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 14 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function clientWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 7 : 354;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function clientHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element") ? 14 : 504;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      return new DOMRect(0, 0, this.clientWidth, this.clientHeight);
    },
  );
  vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
    function proposeDimensions() {
      return { cols: 51, rows: 47 };
    },
  );
}

function stubVisibleIntersectionObserver(deferred = false): void {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private readonly callback: IntersectionObserverCallback,
        _options?: IntersectionObserverInit,
      ) {}

      disconnect(): void {}

      observe(target: Element): void {
        const notify = () =>
          this.callback(
            [
              {
                target,
                isIntersecting: true,
                intersectionRect: new DOMRect(0, 0, 354, 504),
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
        if (deferred) requestAnimationFrame(notify);
        else notify();
      }

      unobserve(): void {}
    },
  );
}

let rerenderMobileTerminal: (
  session: ReturnType<typeof makeTerminalSession>,
) => void = () => undefined;

function renderMobileTerminal(
  overrides: Partial<ReturnType<typeof makeTerminalSession>> = {},
  retainNativeOutput = false,
): ReturnType<typeof makeTerminalSession> {
  const session = makeTerminalSession({
    id: "term_mobile_paste",
    status: "running",
    cols: 40,
    rows: 12,
    ...overrides,
  });
  const tree = (current: ReturnType<typeof makeTerminalSession>) => (
    <MemoryRouter>
      <AppCommandProvider>
        <ThreadTerminalView
          autoFocus={false}
          isPanelOpen
          session={current}
          retainNativeOutput={retainNativeOutput}
        />
      </AppCommandProvider>
    </MemoryRouter>
  );
  const { rerender } = render(tree(session));
  rerenderMobileTerminal = (next) => rerender(tree(next));
  return session;
}

const pageText = () => document.body.textContent ?? "";

function writeReplay(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    writeTerminalOutput({
      data,
      isReplay: true,
      onParsed: resolve,
      replayWriteState: { suppressedWriteCount: 0 },
      terminal,
    });
  });
}

describe("ThreadTerminalView terminal replay and reconnect", () => {
  it("adopts replay and acknowledges fifty-thousand-line history while the screen request is pending", async () => {
    prepareMobileTerminal();
    stubVisibleIntersectionObserver();
    let resolveScreen!: (snapshot: TerminalScreenResponse | null) => void;
    testState.screen.mockReturnValueOnce(
      new Promise<TerminalScreenResponse | null>((resolve) => {
        resolveScreen = resolve;
      }),
    );
    const terminals: Terminal[] = [];
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      if (element.hasAttribute("data-terminal-grid-cache-id"))
        terminals.push(this);
      open.call(this, element);
    });
    const session = renderMobileTerminal();
    try {
      await waitForReadinessCondition(() => {
        expect(terminals).toHaveLength(1);
        expect(testState.sockets).toHaveLength(1);
      }, "viewer did not mount");
      const socket = testState.sockets[0]!;
      await waitForReadiness(socket.opened, "prefetched socket did not open");
      socket.receive({
        type: "attached",
        session,
        replayStartSeq: 40_000,
        nextSeq: 50_000,
      });
      for (let start = 40_000; start < 50_000; start += 500) {
        socket.receive({
          type: "output-batch",
          chunks: Array.from({ length: 500 }, (_, index) => ({
            seq: start + index,
            dataBase64: btoa(`line ${start + index + 1}\r\n`),
          })),
        });
      }
      socket.receive({
        type: "output",
        chunk: { seq: 50_000, dataBase64: btoa("line 50001\r\n") },
      });
      await waitForReadinessCondition(() => {
        expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
          type: "ack",
          nextSeq: 50_001,
        });
      }, "screen request blocked replay adoption and ACK");
      const terminal = terminals[0]!;
      expect(
        Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true),
        ).join("\n"),
      ).toContain("line 50001");
      expect(testState.sockets).toHaveLength(1);
      expect(socket.readyState).toBe(TestTerminalSocket.OPEN);
      await act(async () => {
        resolveScreen({
          complete: true,
          truncated: false,
          cols: terminal.cols,
          gridRows: terminal.rows,
          rows: ["stale checkpoint"],
          cursor: { col: 0, row: 0 },
          checkpointSeq: 40_001,
          dataBase64: btoa("stale checkpoint\r\n"),
        });
      });
      expect(document.body.textContent).not.toContain("stale checkpoint");
      expect(
        Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true),
        ).join("\n"),
      ).toContain("line 50001");
      expect(testState.sockets).toHaveLength(1);
    } finally {
      resolveScreen(null);
    }
  });

  it.each(["before attachment", "after parsed output"])(
    "replays missed output once after a viewer unmounts %s",
    async (phase) => {
      prepareMobileTerminal();
      stubVisibleIntersectionObserver();
      testState.deferSocketOpen = true;
      const mountedTerminals: Terminal[] = [];
      const openTerminal = Terminal.prototype.open;
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
        this: Terminal,
        element: HTMLElement,
      ) {
        if (element.hasAttribute("data-terminal-grid-cache-id")) {
          mountedTerminals.push(this);
        }
        openTerminal.call(this, element);
      });
      const session = renderMobileTerminal();
      await waitForReadinessCondition(() => {
        expect(document.querySelector(".xterm-screen")).not.toBeNull();
        expect(testState.sockets).toHaveLength(1);
      }, "terminal screen was not created before attachment");
      const initialSocket = testState.sockets[0];
      if (!initialSocket) throw new Error("initial socket is missing");
      if (phase === "after parsed output") {
        initialSocket.open();
        initialSocket.receive({
          type: "attached",
          session,
          replayStartSeq: 0,
          nextSeq: 1,
        });
        initialSocket.receive({
          type: "output",
          chunk: { seq: 0, dataBase64: btoa("line 1\r\n") },
        });
        await waitForReadinessCondition(() => {
          expect(
            initialSocket.sent.map((message) => JSON.parse(message)),
          ).toContainEqual({ type: "ack", nextSeq: 1 });
        }, "initial output was not parsed");
      } else {
        expect(initialSocket.readyState).toBe(TestTerminalSocket.CONNECTING);
        expect(initialSocket.sent).toEqual([]);
      }
      cleanup();
      expect(initialSocket.readyState).toBe(TestTerminalSocket.CLOSED);
      renderMobileTerminal();
      await waitForReadinessCondition(() => {
        expect(testState.sockets).toHaveLength(2);
        expect(mountedTerminals).toHaveLength(2);
      }, "returning to the terminal did not create a new viewer");
      const replaySocket = testState.sockets[1];
      const terminal = mountedTerminals[1];
      if (!replaySocket || !terminal)
        throw new Error("returning viewer is missing");
      expect(
        new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
          "sinceSeq",
        ),
      ).toBe("0");
      replaySocket.open();
      replaySocket.receive({
        type: "attached",
        session,
        replayStartSeq: 37,
        nextSeq: 39,
      });
      for (const seq of [37, 38, 38, 39]) {
        replaySocket.receive({
          type: "output",
          chunk: { seq, dataBase64: btoa(`line ${seq + 1}\r\n`) },
        });
      }
      await waitForReadinessCondition(() => {
        expect(
          replaySocket.sent.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 40 });
      }, "returning viewer did not parse replay and later live output");
      await waitFor(
        () => {
          const text = Array.from(
            { length: terminal.buffer.active.length },
            (_, index) =>
              terminal.buffer.active.getLine(index)?.translateToString(true),
          ).join("\n");
          for (const line of [38, 39, 40]) {
            expect(text).toContain(`line ${line}`);
            expect(text.match(new RegExp(`line ${line}`, "g"))).toHaveLength(1);
          }
        },
        { timeout: 5000 },
      );
      expect(testState.sockets).toHaveLength(2);
    },
  );

  it("sends the resolved theme only from the focused viewer and leaves replay replies suppressed", async () => {
    prepareMobileTerminal();
    Reflect.set(
      wsManager,
      "deviceHandoffClientToken",
      "abcdefghijklmnopqrstuv",
    );
    const context = {
      measureText: (text: string) => ({ width: text.length * 9 }),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      getImageData: () => ({
        data: new Uint8ClampedArray([
          ...(context.fillStyle.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [
            12, 34, 56,
          ]),
          255,
        ]),
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (kind) =>
        kind === "2d" ? (context as unknown as CanvasRenderingContext2D) : null,
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    document.documentElement.style.setProperty(
      "--foreground",
      "rgb(228, 228, 228)",
    );
    document.documentElement.style.setProperty("--ink", "rgb(12, 34, 56)");
    document.documentElement.style.setProperty("--sidebar", "rgb(12, 34, 56)");
    testState.setDefaultColors.mockClear();
    const otherViewer = render(<button>Other viewer</button>);
    otherViewer.getByRole("button").focus();
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal did not connect",
    );
    const socket = testState.sockets[0];
    await waitForReadiness(socket.opened, "terminal did not open");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    socket.receive({
      type: "output",
      chunk: {
        seq: 0,
        dataBase64: btoa("history\x1b]10;?\x07\x1b]11;?\x1b\\"),
      },
    });
    expect(testState.setDefaultColors).not.toHaveBeenCalled();
    const textarea = await waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      expect(element).not.toBeNull();
      return element!;
    });
    act(() => textarea.focus());
    await waitFor(() =>
      expect(testState.setDefaultColors).toHaveBeenCalledWith({
        terminalId: session.id,
        viewerToken: "abcdefghijklmnopqrstuv",
        foreground: [12, 34, 56],
        background: [12, 34, 56],
      }),
    );
    act(() =>
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(testState.setDefaultColors).toHaveBeenCalledTimes(1);
    act(() => textarea.blur());
    document.documentElement.style.removeProperty("--foreground");
    document.documentElement.style.removeProperty("--ink");
    document.documentElement.style.removeProperty("--sidebar");
    const lightCss =
      ":root { --foreground: rgb(80, 80, 80); --ink: rgb(51, 51, 51); --sidebar: rgb(250, 250, 250); }";
    act(() => applyAppThemeCss(lightCss));
    await waitFor(() =>
      expect(testState.setDefaultColors).toHaveBeenLastCalledWith({
        terminalId: session.id,
        viewerToken: "abcdefghijklmnopqrstuv",
        foreground: [51, 51, 51],
        background: [250, 250, 250],
      }),
    );
    expect(testState.setDefaultColors).toHaveBeenCalledTimes(2);
    act(() => applyAppThemeCss(lightCss + "\n"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(testState.setDefaultColors).toHaveBeenCalledTimes(2);

    expect(
      socket.sent.filter((raw) => JSON.parse(raw).type === "input"),
    ).toEqual([]);
    document.documentElement.style.removeProperty("--foreground");
    document.documentElement.style.removeProperty("--ink");
    document.documentElement.style.removeProperty("--sidebar");
  });

  it("restores history and one exit notice from exited props without WebSocket messages", async () => {
    prepareMobileTerminal();
    testState.output.mockResolvedValue({
      chunks: [
        {
          seq: 0,
          dataBase64: btoa("retained history one\r\nretained history two\r\n"),
        },
      ],
      nextSeq: 1,
    });
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    renderMobileTerminal({ status: "exited", exitCode: 7 });
    const readBuffer = () =>
      Array.from(
        { length: mountedTerminal?.buffer.active.length ?? 0 },
        (_, index) =>
          mountedTerminal?.buffer.active
            .getLine(index)
            ?.translateToString(true),
      ).join("\n");
    await waitForReadinessCondition(() => {
      expect(readBuffer()).toContain("Terminal exited with code 7");
    }, "exited session did not render its notice without WebSocket messages");
    expect(readBuffer().match(/retained history one/g)).toHaveLength(1);
    expect(readBuffer().match(/retained history two/g)).toHaveLength(1);
    expect(readBuffer().match(/Terminal exited with code 7/g)).toHaveLength(1);
    expect(readBuffer().indexOf("retained history two")).toBeLessThan(
      readBuffer().indexOf("Terminal exited"),
    );
  });

  it("keeps replayed history exactly once when the process exits after replay", async () => {
    prepareMobileTerminal();
    testState.output.mockResolvedValue({
      chunks: [
        {
          seq: 0,
          dataBase64: btoa("replay history one\r\nreplay history two\r\n"),
        },
      ],
      nextSeq: 1,
    });
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "socket did not mount",
    );
    const socket = testState.sockets[0]!;
    await waitForReadiness(socket.opened, "socket did not open");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    socket.receive({
      type: "output",
      chunk: {
        seq: 0,
        dataBase64: btoa("replay history one\r\nreplay history two\r\n"),
      },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "history was not parsed",
    );
    socket.receive({
      type: "exited",
      session: { ...session, status: "exited", exitCode: 7 },
    });
    const readBuffer = () =>
      Array.from(
        { length: mountedTerminal?.buffer.active.length ?? 0 },
        (_, index) =>
          mountedTerminal?.buffer.active
            .getLine(index)
            ?.translateToString(true),
      ).join("\n");
    await waitForReadinessCondition(
      () => expect(readBuffer()).toContain("Terminal exited with code 7"),
      "exit notice was not rendered",
    );
    expect(readBuffer().match(/replay history one/g)).toHaveLength(1);
    expect(readBuffer().match(/replay history two/g)).toHaveLength(1);
    expect(readBuffer().match(/Terminal exited with code 7/g)).toHaveLength(1);
    expect(testState.output).not.toHaveBeenCalled();
  });

  it("replays hidden output across a reconnect before showing the terminal", async () => {
    prepareMobileTerminal();
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });

    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "initial terminal socket was not created within 5000 ms",
    );
    const initialSocket = testState.sockets[0];
    if (!initialSocket) throw new Error("initial terminal socket is missing");
    await waitForReadiness(initialSocket.opened, "initial socket did not open");
    initialSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    initialSocket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("visible baseline\r\n") },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "visible baseline output was not acknowledged",
    );

    const visibilityState = vi.spyOn(document, "visibilityState", "get");
    visibilityState.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "visibility", visible: false }),
      "terminal did not enter the hidden state",
    );
    initialSocket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("ghost range one\r\n") },
    });
    initialSocket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("ghost range two\r\n") },
    });
    initialSocket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "hidden terminal did not reconnect",
    );
    const reconnectSocket = testState.sockets[1];
    if (!reconnectSocket) throw new Error("reconnect socket is missing");
    await waitForReadiness(
      reconnectSocket.opened,
      "reconnect socket did not open",
    );
    expect(
      new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
        "sinceSeq",
      ),
    ).toBe("3");
    reconnectSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 3,
      nextSeq: 3,
    });

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(3),
      "showing terminal did not request replay",
    );
    const replaySocket = testState.sockets[2];
    if (!replaySocket) throw new Error("replay socket is missing");
    await waitForReadiness(replaySocket.opened, "replay socket did not open");
    expect(
      new URL(testState.socketUrls[2] ?? "ws://localhost").searchParams.get(
        "sinceSeq",
      ),
    ).toBe("1");
    replaySocket.receive({
      type: "attached",
      session,
      replayStartSeq: 1,
      nextSeq: 3,
    });
    replaySocket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("ghost range one\r\n") },
    });
    replaySocket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("ghost range two\r\n") },
    });
    await waitForReadinessCondition(() => {
      const terminalText = Array.from(
        { length: mountedTerminal?.buffer.active.length ?? 0 },
        (_, index) =>
          mountedTerminal?.buffer.active
            .getLine(index)
            ?.translateToString(true),
      ).join("\n");
      expect(terminalText).toContain("ghost range one");
    }, "hidden output was not replayed when the terminal became visible");
  });

  it.each([
    { width: 390, cols: 45, rows: 37 },
    { width: 360, cols: 41, rows: 33 },
  ])(
    "claims one final phone grid at $width px while the fit action disappears",
    async ({ cols, rows }) => {
      prepareMobileTerminal();
      const guard = render(<button>Other input</button>);
      guard.getByRole("button").focus();
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
        () => {
          const fit = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent === "Fit to this screen",
          );
          const inFlow =
            fit?.parentElement &&
            getComputedStyle(fit.parentElement).position !== "absolute";
          return { cols, rows: rows - (inFlow ? 2 : 0) };
        },
      );
      const settled = vi.spyOn(
        TerminalWebSocketTransport.prototype,
        "markLayoutSettled",
      );
      const session = renderMobileTerminal({ cols: 132, rows: 41 });
      await waitForReadinessCondition(
        () => expect(settled).toHaveBeenCalled(),
        "phone layout did not settle",
      );
      await waitForReadinessCondition(
        () => expect(testState.sockets).toHaveLength(1),
        "phone did not connect",
      );
      const socket = testState.sockets[0]!;
      await socket.opened;
      const resizes = () =>
        socket.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "resize");
      await waitForReadinessCondition(
        () => expect(resizes().length).toBeGreaterThan(0),
        "phone did not send its fit",
      );
      expect(
        resizes().every((frame) => frame.cols === cols && frame.rows === rows),
      ).toBe(true);
      socket.receive({
        type: "attached",
        session: { ...session, cols, rows },
        replayStartSeq: 0,
        nextSeq: 0,
      });
      await waitForReadinessCondition(
        () => expect(pageText()).not.toContain("Fit to this screen"),
        "fit action did not disappear after ownership fit",
      );
      expect(
        resizes().every((frame) => frame.cols === cols && frame.rows === rows),
      ).toBe(true);
      fireEvent.focus(document.querySelector(".xterm-helper-textarea")!);
      const claims = resizes().filter((frame) => frame.claim === true);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ cols, rows });
    },
  );

  it("keeps the settled grid through initial replay and reconnect without a repaint nudge", async () => {
    prepareFirstAttachFontMetricsHarness();
    const markLayoutSettled =
      TerminalWebSocketTransport.prototype.markLayoutSettled;
    let resolveLayoutSettled!: () => void;
    const layoutSettled = new Promise<void>((resolve) => {
      resolveLayoutSettled = resolve;
    });
    vi.spyOn(
      TerminalWebSocketTransport.prototype,
      "markLayoutSettled",
    ).mockImplementation(function (this: TerminalWebSocketTransport) {
      markLayoutSettled.call(this);
      resolveLayoutSettled();
    });
    let resolveSocketCreated!: () => void;
    const socketCreated = new Promise<void>((resolve) => {
      resolveSocketCreated = resolve;
    });
    testState.socketCreated = resolveSocketCreated;

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_first_attach_font_metrics",
              status: "running",
              cols: 120,
              rows: 36,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitForReadiness(
      socketCreated,
      "socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0]!;
    await Promise.all([socket.opened, layoutSettled]);
    const resizeMessages = () =>
      testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as {
              claim?: boolean;
              cols?: number;
              rows?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize");
    expect(resizeMessages()).toEqual([
      { type: "resize", cols: 51, rows: 47, claim: true },
    ]);

    const session = makeTerminalSession({
      id: "term_first_attach_font_metrics",
      status: "running",
      cols: 120,
      rows: 36,
    });
    vi.useFakeTimers();
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    expect(resizeMessages()).toEqual([
      { type: "resize", cols: 51, rows: 47, claim: true },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPAINT_RESTORE_DELAY_MS + 1);
    });
    expect(resizeMessages()).toEqual([
      { type: "resize", cols: 51, rows: 47, claim: true },
    ]);
    vi.useRealTimers();

    testState.deferSocketOpen = true;
    testState.sockets[0]?.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "terminal did not reconnect",
    );
    const reconnectedSocket = testState.sockets[1]!;
    vi.useFakeTimers();
    reconnectedSocket.open();
    await reconnectedSocket.opened;
    reconnectedSocket.receive({ type: "features", resizeAcks: true });
    reconnectedSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });

    const socketResizes = () =>
      reconnectedSocket.sent
        .map(
          (message) =>
            JSON.parse(message) as {
              cols?: number;
              rows?: number;
              seq?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPAINT_RESTORE_DELAY_MS + 1);
    });
    expect(socketResizes().length).toBeGreaterThan(0);
    expect(
      socketResizes().every(({ cols, rows }) => cols === 51 && rows === 47),
    ).toBe(true);
  });

  it("retries a replay attempt that outlasts the backstop and holds again for the next attempt", async () => {
    const { preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    testState.deferSocketOpen = true;
    let current = socket;
    const holdDeadlineMs =
      terminalReplayPreview.TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS + 1;
    for (const attempt of [1, 2]) {
      const socketsBefore = testState.sockets.length;
      current.disconnect();
      await waitForReadinessCondition(
        () => expect(testState.sockets).toHaveLength(socketsBefore + 1),
        "terminal did not reconnect",
      );
      expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
      expect(preview()?.dataset.terminalReplayHoldExpired).toBeUndefined();
      expect(preview()?.style.visibility).toBe("hidden");

      const reconnectSocket = testState.sockets[socketsBefore];
      if (!reconnectSocket) throw new Error("reconnect socket is missing");
      try {
        vi.useFakeTimers();
        reconnectSocket.open();
        reconnectSocket.receive({
          type: "attached",
          session,
          replayStartSeq: 2,
          nextSeq: 5,
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(holdDeadlineMs);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(attempt === 1 ? 100 : 250);
        });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
      expect(
        reconnectSocket.closeCalls.some(({ code }) => code === 4001),
        `attempt ${attempt} was not retried`,
      ).toBe(true);
      expect(testState.sockets).toHaveLength(socketsBefore + 2);
      expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
      expect(preview()?.style.visibility).toBe("hidden");
      expect(pageText()).toContain("Reconnecting");
      expect(pageText()).not.toContain("Still loading terminal");
      const retrySocket = testState.sockets[socketsBefore + 1];
      if (!retrySocket) throw new Error("retry socket is missing");
      current = retrySocket;
    }
  });

  it("replays output received while the terminal panel is closed", async () => {
    prepareMobileTerminal();
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const session = makeTerminalSession({
      id: "term_panel_replay",
      status: "running",
      cols: 40,
      rows: 12,
    });
    const makeView = (isPanelOpen: boolean) => (
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen={isPanelOpen}
            session={session}
          />
        </AppCommandProvider>
      </MemoryRouter>
    );
    const view = render(makeView(true));
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "initial terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("initial terminal socket is missing");
    await waitForReadiness(socket.opened, "initial socket did not open");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });

    view.rerender(makeView(false));
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "visibility", visible: false }),
      "closed terminal panel did not pause terminal visibility",
    );
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("panel ghost output\r\n") },
    });

    view.rerender(makeView(true));
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "opening terminal panel did not request replay",
    );
    const replaySocket = testState.sockets[1];
    if (!replaySocket) throw new Error("panel replay socket is missing");
    await waitForReadiness(
      replaySocket.opened,
      "panel replay socket did not open",
    );
    expect(
      new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
        "sinceSeq",
      ),
    ).toBe("0");
    replaySocket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    replaySocket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("panel ghost output\r\n") },
    });
    await waitForReadinessCondition(() => {
      const terminalText = Array.from(
        { length: mountedTerminal?.buffer.active.length ?? 0 },
        (_, index) =>
          mountedTerminal?.buffer.active
            .getLine(index)
            ?.translateToString(true),
      ).join("\n");
      expect(terminalText).toContain("panel ghost output");
    }, "panel output was not replayed when the terminal panel reopened");
  });

  it("replays a retained OSC 52 continuation from a parser-safe cursor", async () => {
    prepareMobileTerminal();
    stubVisibleIntersectionObserver();
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockRejectedValue(
      new Error("WebGL unavailable"),
    );
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const visibilityState = vi.spyOn(document, "visibilityState", "get");
    visibilityState.mockReturnValue("hidden");
    const fixture = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "fixtures/osc52-chunks.json",
        ),
        "utf8",
      ),
    ) as {
      osc52: Array<{
        chunks: Array<{
          belInChunk: number;
          dataBase64: string;
          seq: number;
        }>;
      }>;
    };
    const chunks = fixture.osc52[1]?.chunks;
    const prefix = chunks?.[0];
    const continuation = chunks?.[1];
    if (!prefix || !continuation) {
      throw new Error("missing OSC 52 split fixture chunks");
    }
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "initial terminal socket was not created within 5000 ms",
    );
    const initialSocket = testState.sockets[0];
    if (!initialSocket) throw new Error("initial terminal socket is missing");
    await waitForReadiness(initialSocket.opened, "initial socket did not open");
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "visibility", visible: false }),
      "terminal did not enter the hidden state",
    );
    initialSocket.receive({
      type: "attached",
      session,
      replayStartSeq: prefix.seq,
      nextSeq: continuation.seq + 1,
    });
    initialSocket.receive({
      type: "output",
      chunk: { seq: prefix.seq, dataBase64: prefix.dataBase64 },
    });
    initialSocket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "hidden terminal did not reconnect",
    );
    const reconnectSocket = testState.sockets[1];
    if (!reconnectSocket) throw new Error("reconnect socket is missing");
    await waitForReadiness(
      reconnectSocket.opened,
      "reconnect socket did not open",
    );
    expect(
      new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
        "sinceSeq",
      ),
    ).toBe(String(continuation.seq));
    reconnectSocket.receive({
      type: "attached",
      session,
      replayStartSeq: continuation.seq,
      nextSeq: continuation.seq + 1,
    });

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(3),
      "showing terminal did not request replay from its parser cursor",
    );
    const replaySocket = testState.sockets[2];
    if (!replaySocket) throw new Error("replay socket is missing");
    await waitForReadiness(replaySocket.opened, "replay socket did not open");
    const replaySinceSeq = new URL(
      testState.socketUrls[2] ?? "ws://localhost",
    ).searchParams.get("sinceSeq");
    replaySocket.receive({
      type: "attached",
      session,
      replayStartSeq: continuation.seq,
      nextSeq: continuation.seq + 1,
    });
    const continuationBytes = Buffer.from(continuation.dataBase64, "base64");
    const replayBytes =
      replaySinceSeq === "0"
        ? continuationBytes.subarray(continuation.belInChunk + 1)
        : continuationBytes;
    replaySocket.receive({
      type: "output",
      chunk: {
        seq: continuation.seq,
        dataBase64: replayBytes.toString("base64"),
      },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: continuation.seq + 1 }),
      "safe replay output was not acknowledged",
    );
    const capturedTerminal = mountedTerminal as Terminal | null;
    const terminalText = Array.from(
      { length: capturedTerminal?.buffer.active.length ?? 0 },
      (_, index) =>
        capturedTerminal?.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(terminalText).not.toContain("Q".repeat(24));
    expect(replaySinceSeq).toBe("0");
  });

  function paintedScreen() {
    const previewElement = document.querySelector<HTMLElement>(
      "[data-terminal-replay-preview]",
    );
    return Array.from(previewElement?.parentElement?.children ?? []).find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element !== previewElement &&
        element.querySelector(".xterm") !== null,
    );
  }

  it("paints the screen before terminal modules or socket replay arrive", async () => {
    prepareMobileTerminal();
    testState.screen.mockResolvedValue({
      rows: ["early snapshot"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      complete: true,
      truncated: false,
      checkpointSeq: 2,
      dataBase64: btoa("early snapshot"),
    });
    vi.spyOn(terminalModules, "importTerminalModules").mockImplementationOnce(
      () => new Promise(() => {}),
    );
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.screen).toHaveBeenCalledOnce(),
      "screen fetch did not overlap module loading",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector("[data-terminal-screen-loading-preview]")
            ?.textContent,
        ).toBe("early snapshot"),
      "snapshot remained hidden behind module loading",
    );
    expect(testState.sockets).toHaveLength(1);
    expect(testState.sockets[0]!.sent).toEqual([]);
    cleanup();
    expect(
      document.querySelector("[data-terminal-screen-loading-preview]"),
    ).toBeNull();
  });

  it.each([40, 30])(
    "replaces a %i-column loading snapshot with replay history exactly once",
    async (snapshotCols) => {
      prepareMobileTerminal();
      stubVisibleIntersectionObserver();
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
        cols: 40,
        rows: 12,
      });
      const modules = terminalModules.importTerminalModules();
      let finishModules!: () => void;
      vi.spyOn(terminalModules, "importTerminalModules").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishModules = () => {
              void modules.then(resolve);
            };
          }),
      );
      testState.screen.mockResolvedValue({
        rows: ["snapshot text"],
        cursor: { col: 0, row: 0 },
        cols: snapshotCols,
        gridRows: 12,
        complete: true,
        truncated: false,
        checkpointSeq: 1,
        dataBase64: btoa("snapshot text"),
      });
      const terminals: Terminal[] = [];
      const open = Terminal.prototype.open;
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
        this: Terminal,
        element: HTMLElement,
      ) {
        terminals.push(this);
        open.call(this, element);
      });
      const session = renderMobileTerminal();
      await waitFor(() =>
        expect(
          document.querySelector("[data-terminal-screen-loading-preview]")
            ?.textContent,
        ).toBe("snapshot text"),
      );
      expect(testState.sockets).toHaveLength(1);
      expect(testState.sockets[0]!.sent).toEqual([]);
      expect(pageText()).toContain("Restoring session…");
      expect(pageText()).not.toContain("Fit to this screen");
      const previewFontSize = document.querySelector<HTMLElement>(
        "[data-terminal-screen-loading-preview]",
      )!.style.fontSize;
      const snapshotElement = document.querySelector<HTMLElement>(
        "[data-terminal-screen-loading-preview]",
      )!;
      const removeSnapshot = vi.spyOn(snapshotElement, "remove");
      finishModules();
      await waitFor(
        () => expect(document.querySelector(".xterm")).not.toBeNull(),
        {
          timeout: 20_000,
        },
      );
      expect(
        document.querySelector("[data-terminal-screen-loading-preview]")
          ?.textContent,
      ).toBe("snapshot text");
      if (snapshotCols === 40)
        await waitFor(() =>
          expect(
            document.querySelector("[data-terminal-replay-preview]"),
          ).not.toBeNull(),
        );
      const preview = document.querySelector<HTMLElement>(
        "[data-terminal-replay-preview]",
      );
      const socket = testState.sockets[0]!;
      await waitForReadiness(socket.opened, "socket did not open");
      await waitForReadinessCondition(
        () =>
          expect(
            socket.sent.some((frame) => JSON.parse(frame).type === "resize"),
          ).toBe(true),
        "terminal fit did not settle",
      );
      if (snapshotCols === 40)
        await waitFor(() => expect(preview?.style.visibility).toBe("visible"));
      socket.receive({
        type: "attached",
        session,
        replayStartSeq: 0,
        nextSeq: 2,
      });
      await waitFor(() => expect(pageText()).toContain("Restoring session…"));
      expect(pageText()).not.toContain("Fit to this screen");
      expect(
        document.querySelector("[data-terminal-screen-loading-preview]")
          ?.textContent,
      ).toBe("snapshot text");
      expect(pageText()).not.toContain("Reconnecting");
      vi.useFakeTimers();
      await act(() => vi.advanceTimersByTimeAsync(3700));
      vi.useRealTimers();
      expect(pageText()).toContain("Restoring session…");
      expect(pageText()).not.toContain("Fit to this screen");
      expect(
        document
          .querySelector("[data-terminal-restoring]")
          ?.getAttribute("role"),
      ).toBe("status");
      expect(snapshotElement.isConnected).toBe(true);
      expect(snapshotElement.style.whiteSpace).toBe("pre");
      expect(removeSnapshot).not.toHaveBeenCalled();
      socket.receive({
        type: "output",
        chunk: { seq: 0, dataBase64: btoa("older scrollback\r\n") },
      });
      socket.receive({
        type: "output",
        chunk: { seq: 1, dataBase64: btoa("snapshot text\r\n") },
      });
      await waitFor(() => {
        expect(
          document.querySelector("[data-terminal-replay-preview]"),
        ).toBeNull();
        expect(
          document.querySelector("[data-terminal-screen-loading-preview]"),
        ).toBeNull();
        expect(pageText()).not.toContain("Restoring session…");
      });
      const terminal = terminals[0]!;
      expect(previewFontSize).toBe(`${terminal.options.fontSize}px`);
      const text = Array.from(
        { length: terminal.buffer.active.length },
        (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true),
      ).join("\n");
      expect(text).toContain("older scrollback");
      expect(text.match(/snapshot text/g)).toHaveLength(1);
      expect(text.indexOf("older scrollback")).toBeLessThan(
        text.indexOf("snapshot text"),
      );
      expect(
        document.querySelector("[data-terminal-screen-loading-preview]"),
      ).toBeNull();
      expect(removeSnapshot).toHaveBeenCalledOnce();
      expect(pageText()).not.toContain("Restoring session…");
      expect(testState.sockets).toHaveLength(1);
      expect(socket.closeCalls).toHaveLength(0);
      const resizes = socket.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "resize");
      expect(resizes.filter((frame) => frame.claim === true)).toHaveLength(1);
      expect(
        resizes.every((frame) => frame.cols === 40 && frame.rows === 12),
      ).toBe(true);
    },
  );

  it("removes the loading snapshot when terminal modules fail", async () => {
    prepareMobileTerminal();
    testState.screen.mockResolvedValue({
      rows: ["stale snapshot"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      complete: true,
      truncated: false,
      checkpointSeq: 2,
      dataBase64: btoa("stale snapshot"),
    });
    let fail!: (error: Error) => void;
    vi.spyOn(terminalModules, "importTerminalModules").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    renderMobileTerminal();
    await waitFor(() =>
      expect(
        document.querySelector("[data-terminal-screen-loading-preview]"),
      ).not.toBeNull(),
    );
    fail(new Error("renderer unavailable"));
    await waitFor(() =>
      expect(
        document.querySelector("[data-terminal-screen-loading-preview]"),
      ).toBeNull(),
    );
    expect(document.body.textContent).toContain("renderer unavailable");
    expect(testState.sockets[0]!.readyState).toBe(TestTerminalSocket.CLOSED);
    expect(testState.sockets).toHaveLength(1);
    expect(testState.sockets[0]!.sent).toEqual([]);
  });

  async function mountReplayWithUnusableSnapshot() {
    prepareMobileTerminal();
    testState.screen.mockResolvedValue({
      rows: [],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 15,
      truncated: true,
      complete: false,
    });
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const bufferText = () =>
      Array.from(
        { length: mountedTerminal?.buffer.active.length ?? 0 },
        (_, index) =>
          mountedTerminal?.buffer.active
            .getLine(index)
            ?.translateToString(true),
      ).join("\n");
    const preview = () =>
      document.querySelector<HTMLElement>("[data-terminal-replay-preview]");

    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket is missing");
    await waitForReadiness(socket.opened, "terminal socket did not open");
    await waitForReadinessCondition(
      () => expect(testState.screen).toHaveBeenCalledOnce(),
      "screen snapshot was not requested",
    );
    expect(preview()).toBeNull();
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 3,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("stale frame one\r\n") },
    });
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("stale frame two\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("stale frame two"),
      "historical replay output was not parsed",
    );
    expect(preview()).not.toBeNull();
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    return { bufferText, preview, session, socket };
  }

  it("keeps the preview of a replay without a usable snapshot hidden until the replay completes", async () => {
    const marks = vi.spyOn(performance, "mark");
    const { bufferText, preview, socket } =
      await mountReplayWithUnusableSnapshot();
    expect(marks.mock.calls.map(([name]) => name)).toContain(
      "terminal-replay-first-frame-received",
    );
    expect(marks.mock.calls.map(([name]) => name)).not.toContain(
      "terminal-replay-last-xterm-callback",
    );
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("current frame\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("current frame"),
      "final replay output was not parsed",
    );
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the replay completed",
    );
    await waitForReadinessCondition(() => {
      expect(marks.mock.calls.map(([name]) => name)).toContain(
        "terminal-replay-revealed",
      );
    }, "replay reveal timing was not recorded");
    const names = marks.mock.calls.map(([name]) => name);
    for (const name of [
      "terminal-replay-first-frame-received",
      "terminal-replay-last-frame-received",
      "terminal-replay-last-frame-dispatched",
      "terminal-replay-primary-xterm-parsed",
      "terminal-replay-last-xterm-callback",
      "terminal-replay-revealed",
    ]) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    }
    expect(names.indexOf("terminal-replay-last-frame-dispatched")).toBeLessThan(
      names.indexOf("terminal-replay-last-xterm-callback"),
    );
    expect(names.indexOf("terminal-replay-last-xterm-callback")).toBeLessThan(
      names.indexOf("terminal-replay-revealed"),
    );
  });

  it("finishes a non-owner attach using its grid without a later resize or deadline", async () => {
    const setTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      setTimeout(
        handler,
        typeof handler === "function" && handler.name === "handoffAtLatestGrid"
          ? 10_000
          : delay,
        ...args,
      )) as typeof window.setTimeout);
    const { preview, socket } = await mountReplayWithUnusableSnapshot();
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("current frame\r\n") },
    });
    await waitForReadinessCondition(() => {
      expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
        type: "ack",
        nextSeq: 3,
      });
    }, "non-owner replay waited for a resize instead of using its attach grid");
    expect(preview()?.dataset.terminalReplayHeld).toBeUndefined();
    expect(pageText()).not.toContain("Reconnecting");
  });

  it("keeps the preview hidden while the socket is down and holds it again for the replay a reconnect starts", async () => {
    const { bufferText, preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    socket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "terminal did not reconnect",
    );
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    const reconnectSocket = testState.sockets[1];
    if (!reconnectSocket) throw new Error("reconnect socket is missing");
    await waitForReadiness(
      reconnectSocket.opened,
      "reconnect socket did not open",
    );
    reconnectSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 2,
      nextSeq: 5,
    });
    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("retried history\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("retried history"),
      "retried replay output was not parsed",
    );
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");

    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: btoa("more retried history\r\n") },
    });
    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 4, dataBase64: btoa("current frame\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("current frame"),
      "final retried output was not parsed",
    );
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the retried replay completed",
    );
  });

  function shortenReplayHoldTimeout(ms: number) {
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        handler,
        delay ===
          terminalReplayPreview.TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS &&
          typeof handler === "function" &&
          (handler.name === "expireHold" || handler.name === "release")
          ? ms
          : delay,
        ...args,
      )) as typeof window.setTimeout);
  }

  const pause = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, ms));
    });

  it("keeps the preview hidden through a reconnect that outlasts the hold timeout and holds again for the retry", async () => {
    const { bufferText, preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    shortenReplayHoldTimeout(1000);
    testState.deferSocketOpen = true;
    socket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "terminal did not reconnect",
    );
    await pause(1600);
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.dataset.terminalReplayHoldExpired).toBeUndefined();
    expect(preview()?.style.visibility).toBe("hidden");

    const reconnectSocket = testState.sockets[1];
    if (!reconnectSocket) throw new Error("reconnect socket is missing");
    reconnectSocket.open();
    reconnectSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 2,
      nextSeq: 5,
    });
    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("retried history\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("retried history"),
      "retried replay output was not parsed",
    );
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");

    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: btoa("more retried history\r\n") },
    });
    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 4, dataBase64: btoa("current frame\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the retried replay completed",
    );
  });

  it("keeps the painted screen visible and partial output hidden after a stalled replay hold expires", async () => {
    let expireHold: (() => void) | undefined;
    const setTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && handler.name === "expireHold") {
        expireHold = () => handler(...args);
        return setTimeout(() => undefined, 0);
      }
      return setTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout);
    const { bufferText, preview } = await mountReplayWithUnusableSnapshot();
    expect(expireHold).toBeDefined();
    await act(async () => expireHold?.());
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    expect(pageText()).toContain("Reconnecting");
    expect(pageText()).not.toContain("Still loading terminal");
    const status = Array.from(
      document.querySelectorAll('[role="status"]'),
    ).find((element) => element.textContent?.includes("Reconnecting"));
    expect(status?.parentElement?.className.split(/\s+/u)).toContain("flex");
    expect(status && getComputedStyle(status).position).toBe("absolute");
    expect(status?.closest("[data-terminal-replay-preview]")).toBeNull();

    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "stalled replay did not reconnect",
    );
    const retrySocket = testState.sockets[1];
    if (!retrySocket) throw new Error("retry socket is missing");
    await waitForReadiness(retrySocket.opened, "retry socket did not open");
    retrySocket.receive({
      type: "attached",
      session: makeTerminalSession({ id: "term_replay", status: "running" }),
      replayStartSeq: 0,
      nextSeq: 3,
    });
    for (const seq of [0, 1, 2]) {
      retrySocket.receive({
        type: "output",
        chunk: {
          seq,
          dataBase64: btoa(
            seq === 2 ? "current frame\r\n" : `frame ${seq}\r\n`,
          ),
        },
      });
    }
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("current frame"),
      "final replay output was not parsed",
    );
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the replay completed",
    );
    expect(preview()?.dataset.terminalReplayHoldExpired).toBeUndefined();
    expect(pageText()).not.toContain("Reconnecting");
  });

  it("keeps the painted screen visible and the partial output hidden when the transport closes during a stalled replay", async () => {
    shortenReplayHoldTimeout(600);
    const { preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    await waitForReadinessCondition(
      () => expect(pageText()).toContain("Reconnecting"),
      "reconnecting badge was not shown for the stalled replay",
    );
    rerenderMobileTerminal({ ...session, status: "disconnected" });
    socket.disconnect();
    await waitForReadinessCondition(
      () => expect(pageText()).toContain("Terminal disconnected"),
      "closed state was not shown",
    );
    expect(pageText()).not.toContain("Still loading terminal");
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
  });

  function spyOnPreviewProcessExited() {
    const originalMountPreview =
      terminalReplayPreview.mountTerminalReplayPreview;
    const processExited = vi.fn();
    vi.spyOn(
      terminalReplayPreview,
      "mountTerminalReplayPreview",
    ).mockImplementation((options) => {
      const preview = originalMountPreview(options);
      vi.spyOn(preview, "processExited").mockImplementation(processExited);
      return preview;
    });
    return processExited;
  }

  it("keeps the preview hidden when the terminal process exits mid-replay and reveals it with the exit marker once the replay completes", async () => {
    const processExited = spyOnPreviewProcessExited();
    const { bufferText, preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    await act(async () => {
      socket.receive({
        type: "exited",
        session: { ...session, status: "exited", exitCode: 1 },
      });
      await Promise.resolve();
    });
    await pause(200);
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    expect(processExited).not.toHaveBeenCalled();

    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("final frame\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("final frame"),
      "final replay output was not parsed",
    );
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the replay completed",
    );
    expect(processExited).toHaveBeenCalledOnce();
  });

  it("keeps the preview hidden and shows the unavailable state when the replay errors after the process exited", async () => {
    const processExited = spyOnPreviewProcessExited();
    const { preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    await act(async () => {
      socket.receive({
        type: "session-updated",
        session: { ...session, status: "exited", exitCode: 1 },
      });
      await Promise.resolve();
    });
    await act(async () => {
      socket.receive({
        type: "error",
        code: "replay_failed",
        message: "replay failed",
      });
      await Promise.resolve();
    });
    await waitForReadinessCondition(
      () => expect(pageText()).toContain("Terminal output unavailable"),
      "unavailable state was not shown after the exit and the error",
    );
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    expect(processExited).not.toHaveBeenCalled();
  });

  function mountSnapshotPreviewSpyingOnProcessExited() {
    prepareMobileTerminal();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    testState.screen.mockResolvedValue({
      rows: ["snapshot text"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      truncated: false,
      complete: true,
      checkpointSeq: 0,
      dataBase64: btoa("snapshot text"),
    });
    const spy = spyOnPreviewProcessExited();
    const mounted = (async () => {
      const session = renderMobileTerminal();
      await waitForReadinessCondition(
        () =>
          expect(
            document.querySelector("[data-terminal-replay-preview]"),
          ).not.toBeNull(),
        "screen snapshot did not mount a replay preview",
      );
      const socket = testState.sockets[0];
      if (!socket) throw new Error("terminal socket was not created");
      return { session, socket };
    })();
    return { spy, mounted };
  }

  it("marks a fallback preview exited once when the process exit is reported by a session update and an exited message mid-replay", async () => {
    const processExited = spyOnPreviewProcessExited();
    const { bufferText, preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    const exitedSession = {
      ...session,
      status: "exited" as const,
      exitCode: 1,
    };
    await act(async () => {
      socket.receive({ type: "session-updated", session: exitedSession });
      socket.receive({ type: "exited", session: exitedSession });
      await Promise.resolve();
    });
    expect(processExited).not.toHaveBeenCalled();
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("final frame\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(bufferText()).toContain("final frame"),
      "final replay output was not parsed",
    );
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeUndefined(),
      "replay preview stayed held after the replay completed",
    );
    await pause(200);
    expect(processExited).toHaveBeenCalledOnce();
  });

  it("marks a snapshot preview exited once when a session update and an exited message both report the exit", async () => {
    const processExited = mountSnapshotPreviewSpyingOnProcessExited();
    const { session, socket } = await processExited.mounted;
    const exitedSession = {
      ...session,
      status: "exited" as const,
      exitCode: 1,
    };
    await act(async () => {
      socket.receive({ type: "session-updated", session: exitedSession });
      socket.receive({ type: "exited", session: exitedSession });
      await Promise.resolve();
    });
    expect(processExited.spy).not.toHaveBeenCalled();
    socket.receive({
      type: "attached",
      session: exitedSession,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await pause(200);
    expect(processExited.spy).toHaveBeenCalledOnce();
  });

  it("marks a snapshot preview exited once for a single exited message", async () => {
    const processExited = mountSnapshotPreviewSpyingOnProcessExited();
    const { session, socket } = await processExited.mounted;
    await act(async () => {
      socket.receive({
        type: "exited",
        session: { ...session, status: "exited", exitCode: 1 },
      });
      await Promise.resolve();
    });
    expect(processExited.spy).not.toHaveBeenCalled();
    socket.receive({
      type: "attached",
      session: { ...session, status: "exited", exitCode: 1 },
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await pause(200);
    expect(processExited.spy).toHaveBeenCalledOnce();
  });

  async function failReplay(socket: { receive: (message: never) => void }) {
    await act(async () => {
      socket.receive({
        type: "error",
        code: "replay_failed",
        message: "replay failed",
      } as never);
      await Promise.resolve();
    });
  }

  it("keeps the replay hidden and shows the reconnecting badge when a replay fails without a prior screen", async () => {
    shortenReplayHoldTimeout(600);
    const { preview, socket } = await mountReplayWithUnusableSnapshot();
    await failReplay(socket);
    expect(pageText()).toContain("Reconnecting");
    expect(pageText()).not.toContain("Terminal output unavailable");
    expect(preview()?.style.visibility).toBe("hidden");
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "transport did not retry after replay failure",
    );
  });

  async function mountReplayAfterCheckpointedOpen() {
    prepareMobileTerminal();
    stubVisibleIntersectionObserver();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    testState.screen.mockResolvedValue({
      rows: ["snapshot text"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      truncated: false,
      complete: true,
      checkpointSeq: 2,
      dataBase64: btoa("snapshot text"),
    });
    const preview = () =>
      document.querySelector<HTMLElement>("[data-terminal-replay-preview]");
    const session = renderMobileTerminal();
    await waitFor(() => expect(testState.sockets).toHaveLength(1), {
      timeout: 20_000,
    });
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket is missing");
    await waitForReadiness(socket.opened, "terminal socket did not open");
    await waitFor(() => expect(preview()).not.toBeNull(), { timeout: 20_000 });
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 3,
    });
    for (const seq of [0, 1, 2]) {
      socket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa(`open frame ${seq}\r\n`) },
      });
    }
    await waitForReadinessCondition(
      () => expect(preview()).toBeNull(),
      "snapshot preview was not disposed after the replay completed",
    );

    socket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(2),
      "terminal did not reconnect",
    );
    const reconnectSocket = testState.sockets[1];
    if (!reconnectSocket) throw new Error("reconnect socket is missing");
    await waitForReadiness(
      reconnectSocket.opened,
      "reconnect socket did not open",
    );
    reconnectSocket.receive({
      type: "attached",
      session,
      replayStartSeq: 3,
      nextSeq: 6,
    });
    reconnectSocket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: btoa("partial replay\r\n") },
    });
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHeld).toBeDefined(),
      "replay after the checkpointed open was not held",
    );
    expect(preview()?.style.visibility).toBe("hidden");
    return { preview, reconnectSocket, session };
  }

  function expectPaintedScreenKept(preview: () => HTMLElement | null) {
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
    expect(paintedScreen()?.style.opacity).not.toBe("0");
  }

  it("keeps the painted screen visible and partial output hidden after a checkpoint-backed replay hold expires", async () => {
    shortenReplayHoldTimeout(600);
    const { preview } = await mountReplayAfterCheckpointedOpen();
    await waitForReadinessCondition(
      () =>
        expect(
          testState.sockets.some((candidate) =>
            candidate.closeCalls.some(({ code }) => code === 4001),
          ),
        ).toBe(true),
      "stalled replay was not retried after the hold expired",
    );
    expectPaintedScreenKept(preview);
    expect(pageText()).toContain("Reconnecting");
    expect(pageText()).not.toContain("Still loading terminal");
  });

  it("retries after a checkpoint-backed replay error, keeps the painted screen, and recovers without manual action", async () => {
    const { preview, reconnectSocket, session } =
      await mountReplayAfterCheckpointedOpen();
    await failReplay(reconnectSocket);
    expect(pageText()).toContain("Reconnecting");
    expect(pageText()).not.toContain("Terminal output unavailable");
    expectPaintedScreenKept(preview);
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(3),
      "transport did not retry after the replay failure",
    );
    const retrySocket = testState.sockets[2];
    if (!retrySocket) throw new Error("retry socket is missing");
    await waitForReadiness(retrySocket.opened, "retry socket did not open");
    retrySocket.receive({
      type: "attached",
      session,
      replayStartSeq: 4,
      nextSeq: 6,
    });
    for (const seq of [4, 5]) {
      retrySocket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa(`recovered frame ${seq}\r\n`) },
      });
    }
    await waitForReadinessCondition(
      () => expect(preview()).toBeNull(),
      "preview was not disposed after the retried replay completed",
    );
    expect(pageText()).not.toContain("Reconnecting");
    expect(pageText()).not.toContain("Terminal output unavailable");
  });

  it("reconnects on a new socket when a replay stalls on an open socket and settles once the replay arrives", async () => {
    shortenReplayHoldTimeout(600);
    const { preview, session } = await mountReplayAfterCheckpointedOpen();
    const socketsBefore = testState.sockets.length;
    await waitForReadinessCondition(
      () => expect(preview()?.dataset.terminalReplayHoldExpired).toBeDefined(),
      "hold backstop did not fire for the stalled replay",
    );
    expectPaintedScreenKept(preview);
    expect(pageText()).toContain("Reconnecting");
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(socketsBefore + 1),
      "stalled replay did not trigger a reconnect",
    );
    const retrySocket = testState.sockets[socketsBefore];
    if (!retrySocket) throw new Error("retry socket is missing");
    await waitForReadiness(retrySocket.opened, "retry socket did not open");
    retrySocket.receive({
      type: "attached",
      session,
      replayStartSeq: 4,
      nextSeq: 6,
    });
    expectPaintedScreenKept(preview);
    for (const seq of [4, 5]) {
      retrySocket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa(`recovered frame ${seq}\r\n`) },
      });
    }
    await waitForReadinessCondition(
      () => expect(preview()).toBeNull(),
      "preview was not disposed after the retried replay completed",
    );
    expect(pageText()).not.toContain("Reconnecting");
    expect(pageText()).not.toContain("Terminal output unavailable");
    await pause(1_000);
    expect(testState.sockets).toHaveLength(socketsBefore + 1);
  });

  it("claims the terminal on the first key without remeasuring its grid on later keys", async () => {
    prepareMobileTerminal();
    stubVisibleIntersectionObserver();
    testState.screen.mockResolvedValue(null);
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket did not mount",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket is missing");
    await waitForReadiness(socket.opened, "terminal socket did not open");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (!textarea) throw new Error("terminal input did not mount");
    textarea.focus();
    const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const key = () =>
      fireEvent.keyDown(textarea, {
        key: "ArrowLeft",
        code: "ArrowLeft",
        keyCode: 37,
        which: 37,
      });
    bounds.mockClear();
    key();
    expect(bounds.mock.calls.length).toBeGreaterThan(0);
    bounds.mockClear();
    for (let i = 0; i < 40; i += 1) key();
    expect(bounds).not.toHaveBeenCalled();
    expect(
      socket.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "input"),
    ).toHaveLength(41);
  });

  it("backs off instead of spinning when the retried replay also stalls", async () => {
    shortenReplayHoldTimeout(600);
    let notifyRetry = () => {};
    const nextRetry = () =>
      new Promise<void>((resolve) => {
        notifyRetry = resolve;
      });
    let retried = nextRetry();
    const retry = TerminalWebSocketTransport.prototype.retry;
    const retryAttempt = vi
      .spyOn(TerminalWebSocketTransport.prototype, "retry")
      .mockImplementation(function (this: TerminalWebSocketTransport) {
        vi.useFakeTimers();
        retry.call(this);
        notifyRetry();
      });
    const { preview, session } = await mountReplayAfterCheckpointedOpen();
    testState.deferSocketOpen = true;
    let known = testState.sockets.length;
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    for (const delay of [100, 250, 500]) {
      await waitForReadiness(retried, "replay hold did not expire");
      await advance(0);
      expect(retryAttempt).toHaveBeenCalledTimes(known - 1);
      expect(pageText()).toContain("Reconnecting");
      expect(pageText()).not.toContain("Terminal output unavailable");
      await advance(delay - 1);
      expect(testState.sockets).toHaveLength(known);
      await advance(1);
      expect(testState.sockets).toHaveLength(known + 1);
      const next = testState.sockets[known];
      if (!next) throw new Error("retry socket is missing");
      known += 1;
      vi.clearAllTimers();
      vi.useRealTimers();
      retried = nextRetry();
      await act(async () => {
        next.open();
        next.receive({
          type: "attached",
          session,
          replayStartSeq: 4,
          nextSeq: 6,
        });
      });
      expect(preview()?.dataset.terminalReplayHoldExpired).toBeUndefined();
    }
    expect(pageText()).toContain("Reconnecting");
    expect(pageText()).not.toContain("Terminal output unavailable");
    expectPaintedScreenKept(preview);
  }, 30_000);

  it("does not reconnect when a stalled replay belongs to an exited process", async () => {
    shortenReplayHoldTimeout(600);
    const { preview, session, socket } =
      await mountReplayWithUnusableSnapshot();
    await act(async () => {
      socket.receive({
        type: "session-updated",
        session: { ...session, status: "exited", exitCode: 1 },
      });
      await Promise.resolve();
    });
    await waitForReadinessCondition(
      () => expect(pageText()).toContain("Terminal output unavailable"),
      "unavailable state was not shown for the exited process",
    );
    expect(preview()?.style.visibility).toBe("hidden");
    await pause(500);
    expect(testState.sockets).toHaveLength(1);
  });

  it("stays live and reconnects after an error that arrives once the replay completed", async () => {
    const { preview, reconnectSocket } =
      await mountReplayAfterCheckpointedOpen();
    for (const seq of [4, 5]) {
      reconnectSocket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa(`frame ${seq}\r\n`) },
      });
    }
    await waitForReadinessCondition(
      () => expect(preview()).toBeNull(),
      "preview was not disposed after the replay completed",
    );
    await failReplay(reconnectSocket);
    expect(pageText()).not.toContain("Terminal output unavailable");
    expect(pageText()).not.toContain("Reconnecting");

    const socketsBefore = testState.sockets.length;
    reconnectSocket.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(socketsBefore + 1),
      "terminal did not reconnect after the late error",
    );
    expect(pageText()).not.toContain("Terminal output unavailable");
  });

  it("keeps retrying after repeated replay errors and never reaches an unavailable state", async () => {
    const { preview, reconnectSocket, session } =
      await mountReplayAfterCheckpointedOpen();
    let current = reconnectSocket;
    for (const attempt of [1, 2, 3]) {
      await failReplay(current);
      await waitForReadinessCondition(
        () => expect(testState.sockets).toHaveLength(attempt + 2),
        `transport did not retry after replay failure ${attempt}`,
      );
      const next = testState.sockets[attempt + 1];
      if (!next) throw new Error("retry socket is missing");
      await waitForReadiness(next.opened, "retry socket did not open");
      next.receive({
        type: "attached",
        session,
        replayStartSeq: 4,
        nextSeq: 6,
      });
      next.receive({
        type: "output",
        chunk: { seq: 4, dataBase64: btoa("partial replay\r\n") },
      });
      expect(pageText()).toContain("Reconnecting");
      expect(pageText()).not.toContain("Terminal output unavailable");
      expectPaintedScreenKept(preview);
      current = next;
    }
  }, 30_000);

  it("keeps a checkpoint-backed replay hidden and shows the closed state when the transport closes before completion", async () => {
    const { preview, reconnectSocket, session } =
      await mountReplayAfterCheckpointedOpen();
    rerenderMobileTerminal({ ...session, status: "disconnected" });
    reconnectSocket.disconnect();
    await waitForReadinessCondition(
      () => expect(pageText()).toContain("Terminal disconnected"),
      "closed state was not shown",
    );
    expect(preview()?.dataset.terminalReplayHeld).toBeDefined();
    expect(preview()?.style.visibility).toBe("hidden");
  });

  it("notifies the replay preview when a session update reports process exit", async () => {
    prepareMobileTerminal();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    testState.screen.mockResolvedValue({
      rows: ["snapshot text"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      truncated: false,
      complete: true,
      checkpointSeq: 0,
      dataBase64: btoa("snapshot text"),
    });
    const originalMountPreview =
      terminalReplayPreview.mountTerminalReplayPreview;
    const processExited = vi.fn();
    const mountPreview = vi
      .spyOn(terminalReplayPreview, "mountTerminalReplayPreview")
      .mockImplementation((options) => {
        const preview = originalMountPreview(options);
        vi.spyOn(preview, "processExited").mockImplementation(processExited);
        return preview;
      });

    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(mountPreview).toHaveBeenCalledOnce(),
      "screen snapshot did not mount a replay preview",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    await act(async () => {
      socket.receive({
        type: "session-updated",
        session: { ...session, status: "exited" },
      });
      await Promise.resolve();
    });

    expect(processExited).not.toHaveBeenCalled();
    socket.receive({
      type: "attached",
      session: { ...session, status: "exited" },
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await pause(200);
    expect(processExited).toHaveBeenCalledOnce();
  });

  it("reveals before a pending search add-on loads, then attaches it", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    type SearchAddonModule = Awaited<
      ReturnType<typeof terminalModules.importTerminalSearchAddon>
    >;
    let resolveSearch!: (module: SearchAddonModule) => void;
    const searchModule = new Promise<SearchAddonModule>((resolve) => {
      resolveSearch = resolve;
    });
    let SearchAddonConstructor: SearchAddonModule["SearchAddon"] | undefined;
    let resolveSearchAddonAttached!: () => void;
    const searchAddonAttached = new Promise<void>((resolve) => {
      resolveSearchAddonAttached = resolve;
    });
    const searchButton = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-app-terminal] button[aria-label="Search terminal output"]',
      );
    const originalLoadAddon = Terminal.prototype.loadAddon;
    vi.spyOn(Terminal.prototype, "loadAddon").mockImplementation(
      function loadAddon(this: Terminal, addon) {
        originalLoadAddon.call(this, addon);
        if (
          SearchAddonConstructor !== undefined &&
          addon instanceof SearchAddonConstructor
        ) {
          resolveSearchAddonAttached();
        }
      },
    );
    vi.spyOn(terminalModules, "importTerminalSearchAddon").mockReturnValue(
      searchModule,
    );
    const originalOpen = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(
      function openTerminal(this: Terminal, element: HTMLElement) {
        originalOpen.call(this, element);
      },
    );

    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open while search was pending",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    const terminalElement = document.querySelector(".xterm");
    if (!terminalElement) throw new Error("terminal was not opened");
    fireEvent.pointerDown(terminalElement);
    document
      .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
      ?.focus();
    await waitForReadinessCondition(() => {
      const renderer = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      );
      expect(renderer?.style.opacity).toBe("");
    }, "terminal did not reveal while search was pending");
    expect(searchButton()?.disabled).toBe(true);

    const addon = await import("@xterm/addon-search");
    SearchAddonConstructor = addon.SearchAddon;
    await act(async () => {
      resolveSearch(addon);
      await searchAddonAttached;
    });
    expect(searchButton()?.disabled).toBe(false);
  }, 30_000);

  it("keeps the terminal open when an optional search add-on fails", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    vi.spyOn(terminalModules, "importTerminalSearchAddon").mockRejectedValue(
      new Error("search add-on unavailable"),
    );
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open after optional search failed",
    );
    expect(document.querySelector("[data-terminal-renderer]")).not.toBeNull();
  }, 30_000);

  it("uses Unicode 11 cell widths for replayed wide TUI status lines", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    let actualTerminal: Terminal | null = null;
    let unicodeVersionAtOpen: string | undefined;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      actualTerminal = this;
      unicodeVersionAtOpen = this.unicode.activeVersion;
      open.call(this, element);
    });
    class WebglAddon {
      activate(_terminal: Terminal): void {}
      dispose(): void {}
      onContextLoss(_listener: () => void) {
        return { dispose: () => {} };
      }
    }
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockResolvedValue({
      WebglAddon,
    } as Awaited<ReturnType<typeof terminalModules.importTerminalWebglAddon>>);

    renderMobileTerminal();
    await waitForReadinessCondition(() => {
      expect(document.querySelector(".xterm")).not.toBeNull();
      expect(actualTerminal).not.toBeNull();
      expect(unicodeVersionAtOpen).toBe("11");
    }, "Unicode 11 was not active when the terminal opened");
    expect(unicodeVersionAtOpen).toBe("11");
    const terminal = actualTerminal;
    if (!terminal) throw new Error("terminal did not open");
    const line = `🧐界${" ".repeat(31)}12:34`;
    await writeReplay(terminal, line);

    const [{ SearchAddon }, { WebLinksAddon }, { Unicode11Addon }] =
      await Promise.all([
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
    const referenceHost = document.createElement("div");
    document.body.append(referenceHost);
    const reference = new Terminal({
      allowProposedApi: true,
      cols: 40,
      rows: 12,
    });
    reference.loadAddon(new FitAddon());
    reference.loadAddon(new Unicode11Addon());
    reference.unicode.activeVersion = "11";
    reference.open(referenceHost);
    reference.loadAddon(new SearchAddon());
    reference.loadAddon(new WebLinksAddon(() => {}));
    reference.loadAddon(new WebglAddon());
    await new Promise<void>((resolve) => reference.write(line, resolve));

    const positions = (terminal: Terminal) => {
      const row = terminal.buffer.active.getLine(0);
      return {
        emoji: row?.getCell(0)?.getChars(),
        cjk: row?.getCell(2)?.getChars(),
        statusStart: row?.getCell(35)?.getChars(),
        statusEnd: row?.getCell(39)?.getChars(),
        cursorX: terminal.buffer.active.cursorX,
      };
    };
    expect(positions(terminal)).toEqual(positions(reference));
    expect(positions(terminal)).toMatchObject({
      emoji: "🧐",
      cjk: "界",
      statusStart: "1",
      statusEnd: "4",
    });
    reference.dispose();
    referenceHost.remove();
  }, 30_000);

  it.each(["ready", "visibility", "timeout", "failure"] as const)(
    "sends one native cold-open resize when WebGL load ends with %s",
    async (outcome) => {
      prepareFirstAttachFontMetricsHarness();
      testState.touchEnabled = false;
      stubVisibleIntersectionObserver(outcome === "visibility");
      type WebglModule = Awaited<
        ReturnType<typeof terminalModules.importTerminalWebglAddon>
      >;
      let resolveWebgl!: (module: WebglModule) => void;
      let rejectWebgl!: (error: Error) => void;
      vi.spyOn(terminalModules, "importTerminalWebglAddon").mockReturnValue(
        new Promise<WebglModule>((resolve, reject) => {
          resolveWebgl = resolve;
          rejectWebgl = reject;
        }),
      );
      let loseContext = () => {};
      class WebglAddon {
        activate(_terminal: Terminal): void {}
        dispose(): void {}
        onContextLoss(listener: () => void) {
          loseContext = listener;
          return { dispose: () => {} };
        }
      }
      const mounted: { current: Terminal | null } = { current: null };
      const open = Terminal.prototype.open;
      let resolveOpened!: () => void;
      const opened = new Promise<void>((resolve) => {
        resolveOpened = resolve;
      });
      vi.spyOn(Terminal.prototype, "open").mockImplementation(
        function (this: Terminal, element) {
          mounted.current = this;
          open.call(this, element);
          resolveOpened();
        },
      );
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
        () => ({
          cols: 40,
          rows: mounted.current?.options.lineHeight === 1.22 ? 10 : 12,
        }),
      );
      const resizes = () =>
        testState.socketMessages
          .map((message) => JSON.parse(message))
          .filter((message) => message.type === "resize");
      const settled = vi.spyOn(
        TerminalWebSocketTransport.prototype,
        "markLayoutSettled",
      );
      renderMobileTerminal();
      await waitForReadiness(opened, "terminal did not mount");
      if (outcome === "timeout") {
        await waitForReadinessCondition(
          () => expect(settled).toHaveBeenCalled(),
          "terminal layout did not settle before late WebGL load",
        );
        await waitForReadinessCondition(
          () => expect(resizes()).toHaveLength(1),
          "terminal did not fit before late WebGL load",
        );
      }
      await act(async () => {
        if (outcome === "failure") rejectWebgl(new Error("GPU unavailable"));
        else resolveWebgl({ WebglAddon } as WebglModule);
      });
      await waitForReadinessCondition(
        () => expect(resizes()).toHaveLength(1),
        "native cold open sent more than one resize",
      );
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(resizes()).toHaveLength(1);
      expect(mounted.current?.options.lineHeight).toBe(1.22);
      if (outcome === "ready") {
        act(() => loseContext());
        expect(mounted.current?.options.lineHeight).toBe(1.22);
      }
    },
  );

  it("preserves the DOM decision and terminal state when WebGL arrives after replay", async () => {
    prepareFirstAttachFontMetricsHarness();
    testState.touchEnabled = false;
    stubVisibleIntersectionObserver();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    type WebglModule = Awaited<
      ReturnType<typeof terminalModules.importTerminalWebglAddon>
    >;
    let resolveWebgl!: (module: WebglModule) => void;
    const webglModule = new Promise<WebglModule>((resolve) => {
      resolveWebgl = resolve;
    });
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockReturnValue(
      webglModule,
    );
    const actualWebgl = await vi.importActual<WebglModule>("@xterm/addon-webgl");
    const activate = vi.fn();
    class WebglAddon extends actualWebgl.WebglAddon {
      activate = activate;
    }
    const mountedTerminal: { current: Terminal | null } = { current: null };
    const loadAddon = Terminal.prototype.loadAddon;
    vi.spyOn(Terminal.prototype, "loadAddon").mockImplementation(function (
      this: Terminal,
      addon: Parameters<typeof loadAddon>[0],
    ) {
      mountedTerminal.current ??= this;
      loadAddon.call(this, addon);
    });
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open before WebGL resolution",
    );
    const terminal = mountedTerminal.current;
    if (!terminal) throw new Error("terminal did not mount");
    expect(terminal.options.lineHeight).toBe(1.22);
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.some((raw) => {
            const message = JSON.parse(raw);
            return message.type === "resize";
          }),
        ).toBe(true),
      "terminal did not fit before WebGL resolution",
    );
    const history = Array.from(
      { length: 160 },
      (_, index) => `history ${String(index + 1).padStart(3, "0")}`,
    ).join("\r\n");
    await writeReplay(terminal, history);
    await waitForReadinessCondition(
      () => expect(terminal.buffer.active.baseY).toBeGreaterThan(0),
      "replay history did not render before WebGL resolution",
    );
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm-screen")).not.toBeNull(),
      "terminal screen did not render replay history",
    );
    const screen = document.querySelector(".xterm-screen");
    if (!screen) throw new Error("terminal screen was not mounted");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fireEvent.wheel(screen, { deltaY: -120 });
    }
    const before = {
      cols: terminal.cols,
      rows: terminal.rows,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
      retainedLine: terminal.buffer.active.getLine(5)?.translateToString(true),
    };
    expect(before.viewportY).toBeLessThan(before.baseY);
    await act(async () => resolveWebgl({ ...actualWebgl, WebglAddon }));
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.terminalRenderer,
        ).toBe("dom"),
      "late WebGL import changed the settled DOM renderer",
    );
    expect(terminal.options.lineHeight).toBe(1.22);
    expect({
      cols: terminal.cols,
      rows: terminal.rows,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
      retainedLine: terminal.buffer.active.getLine(5)?.translateToString(true),
    }).toEqual(before);
    expect(activate).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps the DOM renderer and replay working when WebGL import fails", async () => {
    prepareMobileTerminal();
    vi.spyOn(terminalModules, "importTerminalWebglAddon").mockRejectedValue(
      new Error("WebGL unavailable"),
    );
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(document.querySelector(".xterm")).not.toBeNull(),
      "terminal did not open after WebGL import failed",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("DOM renderer remains active") },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.terminalRenderer,
        ).toBe("dom"),
      "DOM renderer fallback did not remain active",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          document.querySelector(".xterm")?.textContent?.replace(/\s+/g, " "),
        ).toContain("DOM renderer remains active"),
      "terminal did not render output after WebGL import failed",
    );
  }, 30_000);

  it("mounts and records output boundaries without crypto.randomUUID", async () => {
    prepareMobileTerminal();
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    let uuidBytes: Uint8Array | undefined;
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      const result = originalGetRandomValues(array);
      if (result.byteLength === 16) {
        uuidBytes = new Uint8Array(
          result.buffer,
          result.byteOffset,
          result.byteLength,
        ).slice();
      }
      return result;
    });
    let outputBoundaryHandler:
      | ((payload: string) => boolean | Promise<boolean>)
      | undefined;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      parent: HTMLElement,
    ) {
      open.call(this, parent);
      const registerOscHandler = this.parser.registerOscHandler.bind(
        this.parser,
      );
      vi.spyOn(this.parser, "registerOscHandler").mockImplementation(
        (identifier, callback) => {
          if (identifier === 7778) outputBoundaryHandler = callback;
          return registerOscHandler(identifier, callback);
        },
      );
    });
    try {
      renderMobileTerminal();
      await waitForReadinessCondition(
        () => expect(document.querySelector(".xterm")).not.toBeNull(),
        "terminal did not mount within 5000 ms",
      );
      expect(document.querySelector(".xterm")).not.toBeNull();
      const generatedBytes = uuidBytes;
      if (!generatedBytes) throw new Error("UUID bytes were not generated");
      generatedBytes[6] = (generatedBytes[6]! & 0x0f) | 0x40;
      generatedBytes[8] = (generatedBytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(generatedBytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      const token = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
      if (!outputBoundaryHandler) {
        throw new Error("terminal output boundary handler was not registered");
      }
      expect(await outputBoundaryHandler(`${token}:0`)).toBe(true);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });
});

describe("terminal first paint", () => {
  it("keeps the renderer inset through replay, fitting and session switches", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    const style = document.createElement("style");
    style.textContent = ".pl-2 { padding-left: 8px; }";
    document.head.append(style);
    const insets: string[] = [];
    const terminals: Terminal[] = [];
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      open.call(this, element);
      if (!element.matches("[data-terminal-renderer]")) return;
      terminals.push(this);
      insets.push(getComputedStyle(element).paddingLeft);
      this.onRender(() => {
        insets.push(getComputedStyle(element).paddingLeft);
      });
    });
    try {
      let session = renderMobileTerminal({ cols: 120, rows: 36 });
      for (let index = 0; index < 2; index += 1) {
        await waitForReadinessCondition(() => {
          expect(testState.sockets).toHaveLength(index + 1);
        }, "terminal socket did not mount");
        const socket = testState.sockets[index]!;
        await waitForReadiness(socket.opened, "terminal socket did not open");
        socket.receive({
          type: "attached",
          session,
          replayStartSeq: 0,
          nextSeq: 1,
        });
        socket.receive({
          type: "output",
          chunk: { seq: 0, dataBase64: btoa("SWITCH-INSET\r\n") },
        });
        await waitForReadinessCondition(() => {
          expect(
            socket.sent.map((message) => JSON.parse(message)),
          ).toContainEqual({
            type: "ack",
            nextSeq: 1,
          });
        }, "terminal replay did not finish");
        const host = document.querySelector<HTMLElement>(
          "[data-terminal-renderer]",
        )!;
        expect(getComputedStyle(host).paddingLeft).toBe("8px");
        socket.receive({
          type: "session-updated",
          session: { ...session, cols: 51, rows: 47 },
        });
        await act(async () => {
          await writeReplay(terminals[index]!, "");
        });
        expect(getComputedStyle(host).paddingLeft).toBe("8px");
        if (index === 0) {
          session = { ...session, id: "term_switch_inset" };
          rerenderMobileTerminal(session);
        }
      }
      expect(insets.length).toBeGreaterThan(2);
      expect(new Set(insets)).toEqual(new Set(["8px"]));
    } finally {
      style.remove();
    }
  });

  it("fits a live native session at phone width without retained-history scrolling", async () => {
    prepareFirstAttachFontMetricsHarness();
    testState.touchEnabled = true;
    vi.stubGlobal("innerWidth", 390);
    const session = renderMobileTerminal({ cols: 120, rows: 36 }, true);
    await waitForReadinessCondition(() => {
      expect(testState.sockets).toHaveLength(1);
    }, "live terminal socket did not mount");
    const socket = testState.sockets[0]!;
    await waitForReadiness(socket.opened, "live terminal socket did not open");
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual(
        expect.objectContaining({ type: "resize", cols: 51, rows: 47 }),
      );
    }, "live terminal did not send the phone fit");
    socket.receive({
      type: "attached",
      session: { ...session, cols: 51, rows: 47 },
      replayStartSeq: 0,
      nextSeq: 1,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("LIVE-PHONE-FIT\r\n") },
    });
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "ack", nextSeq: 1 });
    }, "live terminal replay did not finish");
    const host = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    expect(host.dataset.fitGridCols).toBe("51");
    expect(host.dataset.renderGridCols).toBe("51");
    expect(host.style.opacity).toBe("");
    expect(host.style.overflowX).toBe("");
    expect(host.style.overflowY).toBe("");
    expect(host.style.paddingLeft).toBe("");
    expect(host.style.touchAction).toBe("");
    const documentTouch = vi.fn();
    document.addEventListener("touchcancel", documentTouch);
    try {
      fireEvent.touchCancel(host, { touches: [], changedTouches: [] });
      expect(documentTouch).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("touchcancel", documentTouch);
    }
    expect(
      host.querySelector<HTMLElement>(".xterm")?.dataset.surfaceScale,
    ).toBe("1");
  });

  it.each([80, 120, 200])(
    "keeps phone history at the normal text size for %i recorded columns",
    async (cols) => {
      prepareFirstAttachFontMetricsHarness();
      testState.touchEnabled = true;
      vi.stubGlobal("innerWidth", 390);
      vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue({
        cols: 49,
        rows: 48,
      });
      let actualTerminal: Terminal | null = null;
      const open = Terminal.prototype.open;
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
        this: Terminal,
        element: HTMLElement,
      ) {
        actualTerminal = this;
        open.call(this, element);
      });
      const prompt = `Hgjpq${"x".repeat(cols - 6)}]`;
      testState.output.mockResolvedValue({
        chunks: [
          {
            seq: 0,
            dataBase64: btoa(
              `\x1b]7791;bb-grid;${cols};36\x07\x1b[48;5;8m${prompt}\x1b[0m\r\nAFTER-BAND`,
            ),
          },
        ],
        nextSeq: 1,
      });
      renderMobileTerminal(
        { status: "exited", exitCode: 0, cols, rows: 36 },
        true,
      );
      await waitForReadinessCondition(() => {
        expect(pageText()).toContain("Terminal exited with code");
      }, "retained replay did not finish");
      await act(async () => {
        await writeReplay(actualTerminal!, "");
      });
      const host = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      )!;
      const surface = host.querySelector<HTMLElement>(".xterm")!;
      expect(host.dataset.renderGridCols).toBe(String(cols));
      expect(host.style.opacity).toBe("");
      expect(surface.dataset.surfaceScale).toBe("1");
      expect(surface.style.transform).toBe("scale(1)");
      expect(host.style.overflowX).toBe("auto");
      expect(host.style.overflowY).toBe("auto");
      expect(host.style.touchAction).toBe("pan-x pan-y");
      expect(host.parentElement?.classList.contains("touch-pan-x")).toBe(true);
      expect(host.parentElement?.classList.contains("touch-pan-y")).toBe(true);
      expect(
        actualTerminal!.buffer.active.getLine(0)?.translateToString(true),
      ).toBe(prompt);
      expect(
        actualTerminal!.buffer.active.getLine(1)?.translateToString(true),
      ).toBe("AFTER-BAND");
    },
  );

  it.each([
    { width: 767, compact: true },
    { width: 768, compact: false },
    { width: 768, compact: true },
    { width: 767, compact: false },
  ])(
    "uses compact media-query result $compact at viewport width $width for history gestures",
    async ({ width, compact }) => {
      prepareFirstAttachFontMetricsHarness();
      vi.stubGlobal("innerWidth", width);
      const mediaQuery = window.matchMedia(COMPACT_VIEWPORT_QUERY);
      vi.mocked(window.matchMedia).mockImplementation((query) => ({
        ...mediaQuery,
        media: query,
        matches: query === COMPACT_VIEWPORT_QUERY ? compact : false,
      }));
      renderMobileTerminal(
        { status: "exited", exitCode: 0, cols: 120, rows: 96 },
        true,
      );
      await waitForReadinessCondition(() => {
        expect(pageText()).toContain("Terminal exited with code");
      }, "retained replay did not finish");
      const host = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      )!;
      expect(host.style.touchAction).toBe(compact ? "pan-x pan-y" : "");
      expect(host.style.overflowX).toBe(compact ? "auto" : "");
      const documentTouch = vi.fn();
      document.addEventListener("touchcancel", documentTouch);
      try {
        fireEvent.touchCancel(host, { touches: [], changedTouches: [] });
        expect(documentTouch).toHaveBeenCalledTimes(compact ? 0 : 1);
      } finally {
        document.removeEventListener("touchcancel", documentTouch);
      }
    },
  );

  it("leaves exited phone-history swipes to the browser instead of xterm's document handlers", async () => {
    prepareFirstAttachFontMetricsHarness();
    testState.touchEnabled = true;
    vi.stubGlobal("innerWidth", 390);
    renderMobileTerminal(
      { status: "exited", exitCode: 0, cols: 120, rows: 96 },
      true,
    );
    await waitForReadinessCondition(() => {
      expect(pageText()).toContain("Terminal exited with code");
    }, "retained replay did not finish");
    const host = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    const documentTouch = vi.fn();
    const captureTouch = vi.fn();
    const types = ["touchstart", "touchmove", "touchend", "touchcancel"];
    for (const type of types) {
      document.addEventListener(type, documentTouch);
      document.addEventListener(type, captureTouch, true);
    }
    try {
      const point = {
        identifier: 1,
        clientX: 100,
        clientY: 100,
        pageX: 100,
        pageY: 100,
        target: host,
      };
      const active = Object.assign([point], {
        item: (index: number) => (index === 0 ? point : null),
      });
      const empty = Object.assign([], { item: () => null });
      for (const type of types) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, {
          touches:
            type === "touchstart" || type === "touchmove" ? active : empty,
          targetTouches:
            type === "touchstart" || type === "touchmove" ? active : empty,
          changedTouches: active,
        });
        fireEvent(host, event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(documentTouch).not.toHaveBeenCalled();
      expect(captureTouch).toHaveBeenCalledTimes(4);
    } finally {
      for (const type of types) {
        document.removeEventListener(type, documentTouch);
        document.removeEventListener(type, captureTouch, true);
      }
    }
  });

  it("hides exited native replay until the first fitted resize", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    const paintOpacities: string[] = [];
    const write = Terminal.prototype.write;
    vi.spyOn(Terminal.prototype, "write").mockImplementation(
      function (this: Terminal, data, callback) {
        paintOpacities.push(
          document.querySelector<HTMLElement>("[data-terminal-renderer]")!.style
            .opacity,
        );
        write.call(this, data, callback);
      },
    );
    let finishOutput!: (value: {
      chunks: { seq: number; dataBase64: string }[];
      nextSeq: number;
    }) => void;
    testState.output.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOutput = resolve;
        }),
    );
    renderMobileTerminal({ status: "exited", cols: 135, rows: 56 }, true);
    await waitForReadinessCondition(
      () => expect(testState.output).toHaveBeenCalled(),
      "retained output was not requested",
    );
    const surface = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    expect(surface.style.opacity).toBe("0");
    await act(async () => {
      finishOutput({
        chunks: [
          {
            seq: 0,
            dataBase64: btoa(
              "\x1b]7791;bb-grid;135;56\x07PHONE-FIRST-PAINT-MARKER\r\n",
            ),
          },
        ],
        nextSeq: 1,
      });
    });
    await waitForReadinessCondition(() => {
      expect(surface.dataset.renderGridCols).toBe("135");
      expect(surface.style.opacity).toBe("");
    }, "fitted retained output was not revealed");
    expect(paintOpacities.length).toBeGreaterThan(0);
    expect(paintOpacities.every((opacity) => opacity === "0")).toBe(true);
  });

  it("preserves a full prompt band when phone fit is narrower than retained output", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue({
      cols: 49,
      rows: 48,
    });
    let actualTerminal: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      actualTerminal = this;
      open.call(this, element);
    });
    const prompt = "  thr_i8bb9fauv2.[child of @thread:thr_i8bb9fauv2]";
    testState.output.mockResolvedValue({
      chunks: [
        {
          seq: 0,
          dataBase64: btoa(
            `\x1b]7791;bb-grid;51;48\x07\x1b[48;5;8m\x1b[K${prompt}\x1b[0m\r\nAFTER-BAND`,
          ),
        },
      ],
      nextSeq: 1,
    });
    renderMobileTerminal(
      { status: "exited", exitCode: 0, cols: 51, rows: 48 },
      true,
    );
    await waitForReadinessCondition(() => {
      expect(pageText()).toContain("Terminal exited with code");
    }, "retained replay did not finish");
    await act(async () => {
      await writeReplay(actualTerminal!, "");
    });
    const surface = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    expect(surface.style.opacity).toBe("");
    expect(surface.dataset.fitGridCols).toBe("49");
    expect(surface.dataset.renderGridCols).toBe("51");
    expect(surface.style.paddingLeft).toBe("");
    expect(
      surface.querySelector<HTMLElement>(".xterm")?.dataset.surfaceScale,
    ).toBe("1");
    expect(
      actualTerminal!.buffer.active.getLine(0)?.translateToString(true),
    ).toBe(prompt);
    expect(
      actualTerminal!.buffer.active.getLine(1)?.translateToString(true),
    ).toBe("AFTER-BAND");
  });

  it("keeps the terminal hidden when its first fit has no dimensions", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue(undefined);
    let opened = false;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      open.call(this, element);
      opened = true;
    });
    renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(opened).toBe(true),
      "terminal did not open",
    );
    expect(
      document.querySelector<HTMLElement>("[data-terminal-renderer]")!.style
        .opacity,
    ).toBe("0");
  });
});

describe("terminal first paint recovery", () => {
  it.each([
    ["resolve", true],
    ["reject", true],
    ["resolve", false],
    ["reject", false],
    ["write", true],
    ["write", false],
  ] as const)(
    "releases terminal listeners after late history %s with retained output %s",
    async (settlement, retainNativeOutput) => {
      prepareFirstAttachFontMetricsHarness();
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      let parsed: (() => void) | undefined;
      if (settlement === "write") {
        const write = Terminal.prototype.write;
        vi.spyOn(Terminal.prototype, "write").mockImplementation(
          function (this: Terminal, data, callback) {
            write.call(this, data, () => {
              if (data === "" && callback) parsed = callback;
              else callback?.();
            });
          },
        );
      }
      for (let navigation = 0; navigation < 4; navigation++) {
        let resolveOutput!: (value: { chunks: []; nextSeq: number }) => void;
        let rejectOutput!: (reason: Error) => void;
        testState.output.mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              resolveOutput = resolve;
              rejectOutput = reject;
            }),
        );
        renderMobileTerminal(
          { status: "exited", exitCode: 0 },
          retainNativeOutput,
        );
        await waitForReadinessCondition(() => {
          expect(testState.output).toHaveBeenCalledTimes(navigation + 1);
        }, "history was not requested");
        if (settlement === "write") {
          await act(async () => resolveOutput({ chunks: [], nextSeq: 0 }));
          await waitForReadinessCondition(() => {
            expect(parsed).toBeTypeOf("function");
          }, "history parsing did not reach its completion callback");
        }
        cleanup();
        await act(async () => {
          if (settlement === "resolve")
            resolveOutput({ chunks: [], nextSeq: 0 });
          else if (settlement === "reject")
            rejectOutput(new Error("history unavailable"));
          else parsed?.();
        });
        parsed = undefined;
        const active = new Set<EventListenerOrEventListenerObject>();
        for (const [event, listener] of add.mock.calls) {
          if (event === "pointerup") active.add(listener);
        }
        for (const [event, listener] of remove.mock.calls) {
          if (event === "pointerup") active.delete(listener);
        }
        expect(active.size).toBe(0);
      }
    },
  );
  it("reconciles retained history arriving after the timeout", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    const restore = vi.spyOn(
      terminalViewport,
      "resolveTerminalViewportRestore",
    );
    const mounted: { current: Terminal | null } = { current: null };
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(
      function (this: Terminal, container) {
        mounted.current ??= this;
        open.call(this, container);
      },
    );
    let resolveOutput!: (output: {
      chunks: { seq: number; dataBase64: string }[];
      nextSeq: number;
    }) => void;
    let requested!: () => void;
    const outputRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    testState.output.mockImplementation(() => {
      vi.useFakeTimers();
      requested();
      return new Promise((resolve) => {
        resolveOutput = resolve;
      });
    });
    renderMobileTerminal(
      { status: "exited", exitCode: 7, cols: 135, rows: 56 },
      true,
    );
    try {
      await waitForReadiness(
        outputRequested,
        "retained output was not requested",
      );
      const terminal = mounted.current;
      if (!terminal) throw new Error("terminal did not mount");
      const transcript = () =>
        Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true),
        ).join("\n");
      const surface = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      )!;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          terminalReplayPreview.TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS + 100,
        );
      });
      expect(transcript()).toContain("Terminal history unavailable");
      expect(surface.style.opacity).toBe("");
      await act(async () => {
        resolveOutput({
          chunks: [
            {
              seq: 40,
              dataBase64: btoa(
                Array.from(
                  { length: 100 },
                  (_, i) => `Late history ${i}\r\n`,
                ).join(""),
              ),
            },
            { seq: 77, dataBase64: btoa("Late history tail\r\n") },
          ],
          nextSeq: 99,
        });
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(transcript()).toContain("Late history 0");
      expect(transcript()).toContain("Late history tail");
      expect(transcript()).not.toContain("Terminal history unavailable");
      expect(transcript().match(/Terminal exited with code 7/g)).toHaveLength(
        1,
      );
      expect(transcript().trimEnd()).toMatch(
        /Late history tail\n+Terminal exited with code 7$/,
      );
      expect(surface.style.opacity).toBe("");
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({
          replayStartSequence: 40,
          replayNextSequence: 99,
        }),
        expect.any(Function),
      );
      vi.spyOn(
        terminalViewport,
        "findTerminalOutputLineAnchor",
      ).mockReturnValue(undefined);
      fireEvent.wheel(surface, { deltaY: -120 });
      terminal.scrollToLine(0);
      terminal.scrollToLine(1);
      fireEvent(window, new Event("pagehide"));
      expect(
        terminalViewport.readTerminalViewportAnchor(
          sessionStorage,
          "bb:terminal-viewport:term_mobile_paste",
        )?.outputSequence,
      ).toBe(77);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reveals an exit and error state when retained output rejects", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    testState.output.mockRejectedValue(
      new Error("retained output fetch failed"),
    );
    renderMobileTerminal(
      { status: "exited", exitCode: 7, cols: 135, rows: 56 },
      true,
    );
    await waitForReadinessCondition(() => {
      const surface = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      )!;
      expect(surface.style.opacity).toBe("");
      expect(surface.dataset.renderGridCols).toBe("135");
      expect(pageText()).toContain("Terminal history unavailable");
      expect(pageText()).toContain("Terminal exited with code 7");
    }, "failed retained output left no visible exit state");
  });

  it("reveals an exit state when retained output never settles", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.stubGlobal("innerWidth", 390);
    let requested!: () => void;
    const outputRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    testState.output.mockImplementation(() => {
      vi.useFakeTimers();
      requested();
      return new Promise(() => undefined);
    });
    renderMobileTerminal(
      { status: "exited", exitCode: 7, cols: 135, rows: 56 },
      true,
    );
    try {
      await waitForReadiness(
        outputRequested,
        "retained output was not requested",
      );
      const surface = document.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      )!;
      expect(surface.style.opacity).toBe("0");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          terminalReplayPreview.TERMINAL_REPLAY_PREVIEW_HOLD_TIMEOUT_MS + 100,
        );
      });
      expect(surface.style.opacity).toBe("");
      expect(surface.dataset.renderGridCols).toBe("135");
      expect(pageText()).toContain("Terminal history unavailable");
      expect(pageText()).toContain("Terminal exited with code 7");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses current status when an exited session becomes running without remount", async () => {
    prepareFirstAttachFontMetricsHarness();
    testState.output.mockImplementation(() => new Promise(() => undefined));
    const open = vi.spyOn(Terminal.prototype, "open");
    const session = renderMobileTerminal(
      { status: "exited", cols: 80, rows: 24 },
      true,
    );
    await waitForReadinessCondition(
      () => expect(testState.output).toHaveBeenCalled(),
      "retained output was not requested",
    );
    const surface = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    expect(surface.style.opacity).toBe("0");
    rerenderMobileTerminal({ ...session, status: "running" });
    fireEvent(window, new Event("resize"));
    await waitForReadinessCondition(
      () => expect(surface.style.opacity).toBe(""),
      "current running status was not revealed",
    );
    rerenderMobileTerminal(session);
    fireEvent(window, new Event("resize"));
    expect(surface.style.opacity).toBe("0");
    expect(
      open.mock.calls.filter(([container]) => container === surface),
    ).toHaveLength(1);
  });

  it("fits a running session that exits without remount before revealing it", async () => {
    prepareFirstAttachFontMetricsHarness();
    vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue({
      cols: 80,
      rows: 24,
    });
    testState.deferSocketOpen = true;
    vi.stubGlobal("innerWidth", 390);
    const open = vi.spyOn(Terminal.prototype, "open");
    const session = renderMobileTerminal({ cols: 80, rows: 24 }, true);
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "running terminal did not mount",
    );
    const surface = document.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    const socket = testState.sockets[0]!;
    socket.open();
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await waitForReadinessCondition(
      () => expect(surface.style.opacity).toBe(""),
      "running terminal was not visible",
    );
    vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue(undefined);
    rerenderMobileTerminal({ ...session, status: "exited", exitCode: 0 });
    fireEvent(window, new Event("resize"));
    expect(surface.style.opacity).toBe("0");
    vi.mocked(FitAddon.prototype.proposeDimensions).mockReturnValue({
      cols: 51,
      rows: 47,
    });
    rerenderMobileTerminal({
      ...session,
      status: "exited",
      exitCode: 0,
    });
    await waitForReadinessCondition(() => {
      expect(surface.style.opacity).toBe("");
      expect(surface.dataset.renderGridCols).toBe("80");
    }, "newly exited terminal was not fitted and revealed");
    expect(
      open.mock.calls.filter(([container]) => container === surface),
    ).toHaveLength(1);
  });
});
