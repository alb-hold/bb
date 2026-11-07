// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import * as rendererModule from "./terminal-webgl-renderer";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm";
import { TerminalWebSocketTransport } from "@bb/client-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";
import { importTerminalModules } from "./terminal-modules";
import {
  readCachedTerminalGrid,
  rememberTerminalGrid,
} from "./terminal-grid-cache";
import {
  prefetchTerminalSocket,
  discardPrefetchedTerminalSocket,
} from "./terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "./terminal-websocket-url";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
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
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

class TestTerminalSocket {
  readonly protocol = "bb.terminal.replay-batch.v1";
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

  close(): void {
    this.readyState = TestTerminalSocket.CLOSED;
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
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  localStorage.clear();
  vi.useRealTimers();
  cleanup();
  for (const url of testState.socketUrls) discardPrefetchedTerminalSocket(url);
  sessionStorage.removeItem("bb:terminal-viewport:term_mobile_paste");
  sessionStorage.removeItem("bb:terminal-viewport:term_existing_client_grid");
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

describe("native terminal attach claim timing", () => {
  it.each(
    [44, 125].flatMap((cols) =>
      ["ready", "pending", "delayed"].flatMap((pendingScreen) =>
        ["miss", "match", "mismatch"].map((cacheMode) => ({
          cols,
          pendingScreen,
          cacheMode,
        })),
      ),
    ),
  )(
    "claims the fitted $cols-column grid (screen: $pendingScreen, cache: $cacheMode)",
    async ({ cols, pendingScreen, cacheMode }) => {
      localStorage.clear();
      if (pendingScreen === "pending")
        testState.screen.mockReturnValue(new Promise(() => undefined));
      if (pendingScreen === "delayed")
        testState.screen.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(null), 700)),
        );
      vi.stubGlobal("WebSocket", TestTerminalSocket);
      const focusGuard = render(<button>Other input</button>);
      focusGuard.getByRole("button").focus();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        measureText: (text: string) => ({ width: text.length * 8 }),
      } as unknown as CanvasRenderingContext2D);
      for (const dimension of [
        "clientWidth",
        "offsetWidth",
        "clientHeight",
        "offsetHeight",
      ] as const) {
        vi.spyOn(HTMLElement.prototype, dimension, "get").mockReturnValue(354);
      }
      let webglVisible = () => false;
      vi.spyOn(rendererModule, "loadTerminalWebglRenderer").mockReturnValue({
        renderer: "dom",
        setVisible: vi.fn(),
        dispose: vi.fn(),
      });
      vi.spyOn(
        rendererModule,
        "observeTerminalWebglVisibility",
      ).mockImplementation(({ isPanelOpen }) => {
        webglVisible = isPanelOpen;
        return { sync: vi.fn(), dispose: vi.fn() };
      });
      vi.spyOn(
        rendererModule,
        "loadOptionalTerminalWebglAddon",
      ).mockResolvedValue({
        WebglAddon: class {
          activate() {}
          dispose() {}
          onContextLoss() {
            return { dispose() {} };
          }
        },
      });
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
        cols,
        rows: 36,
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 354,
        height: 504,
        top: 0,
        left: 0,
        right: 354,
        bottom: 504,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.set(++frameId, callback);
          return frameId;
        },
      );
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      let resizeAt: number | undefined;
      const originalSendResize =
        TerminalWebSocketTransport.prototype.sendResize;
      const sendResize = vi
        .spyOn(TerminalWebSocketTransport.prototype, "sendResize")
        .mockImplementation(
          function (this: TerminalWebSocketTransport, cols, rows, claim) {
            if (claim) resizeAt ??= Date.now();
            originalSendResize.call(this, cols, rows, claim);
          },
        );
      const session = makeTerminalSession({
        id: "term_existing_client_grid",
        threadId: null,
        status: "running",
        ...(cacheMode === "match" ? { cols, rows: 36 } : {}),
      });
      await importTerminalModules();
      vi.useFakeTimers();
      testState.deferSocketOpen = true;
      let adoptedAt: number | undefined;
      const originalStart = TerminalWebSocketTransport.prototype.start;
      const startTransport = vi
        .spyOn(TerminalWebSocketTransport.prototype, "start")
        .mockImplementation(function (this: TerminalWebSocketTransport) {
          adoptedAt ??= Date.now();
          originalStart.call(this);
        });
      const cachedCols = cacheMode === "mismatch" ? cols + 1 : cols;
      if (cacheMode !== "miss") {
        rememberTerminalGrid(session.id, document.createElement("div"), 13, {
          cols: cachedCols,
          rows: 36,
        });
      }
      prefetchTerminalSocket(
        buildTerminalWebSocketUrl({
          terminalId: session.id,
          handoffOwnerToken: wsManager.getDeviceHandoffClientToken(),
        }),
      );
      expect(testState.sockets).toHaveLength(1);
      const attachedAt = Date.now();
      let claimAt: number | undefined;
      const socket = testState.sockets[0]!;
      const send = socket.send.bind(socket);
      vi.spyOn(socket, "send").mockImplementation((data) => {
        if (JSON.parse(data).claim) claimAt ??= Date.now();
        send(data);
      });
      socket.open();
      socket.receive({
        type: "attached",
        session,
        replayStartSeq: 0,
        nextSeq: 1,
      });
      socket.receive({
        type: "output-batch",
        chunks: [
          { seq: 0, dataBase64: btoa("Retained output\r\n".repeat(400)) },
        ],
      });
      expect(
        document.querySelector("[data-terminal-grid-cache-id]"),
      ).toBeNull();
      if (cacheMode === "miss") {
        expect(claimAt).toBeUndefined();
      } else {
        expect(claimAt! - attachedAt).toBeLessThanOrEqual(5);
        expect(startTransport).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(700);
      }
      const renderedAt = Date.now();
      let fontsReady: (() => void) | undefined;
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: Object.assign(fonts, {
          status: "loading",
          ready: new Promise<void>((resolve) => {
            fontsReady = resolve;
          }),
        }),
      });
      render(
        <MemoryRouter>
          <AppCommandProvider>
            <div data-native-terminal-thread="codex">
              <ThreadTerminalView
                autoFocus={false}
                isPanelOpen
                session={session}
              />
            </div>
          </AppCommandProvider>
        </MemoryRouter>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(startTransport).toHaveBeenCalledOnce();
      expect(adoptedAt! - renderedAt).toBeLessThanOrEqual(16);
      expect(webglVisible()).toBe(false);
      expect(
        document.querySelector('[data-replay-held="true"]'),
      ).not.toBeNull();
      if (cacheMode === "miss") expect(claimAt).toBeUndefined();
      Object.assign(fonts, { status: "loaded" });
      fontsReady?.();
      let revealedAt: number | undefined;
      for (let frame = 0; frame < 50; frame += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(16);
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(performance.now());
        });
        if (document.querySelector('[data-replay-held="false"]'))
          revealedAt ??= Date.now();
      }
      expect(startTransport).toHaveBeenCalledOnce();
      expect(testState.socketUrls).toHaveLength(1);
      expect(adoptedAt).toBeDefined();
      expect(claimAt).toBeDefined();
      if (cacheMode === "match") {
        expect(webglVisible()).toBe(true);
        expect(
          document.querySelector('[data-replay-held="false"]'),
        ).not.toBeNull();
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: "ack",
          nextSeq: 1,
        });
        expect(revealedAt! - renderedAt).toBeLessThanOrEqual(64);
      }
      const claims = socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.type === "resize");
      console.info("P74 prefetched attach-to-claim", {
        cols,
        cacheMode,
        pendingScreen,
        adoptionFromMount: adoptedAt! - renderedAt,
        claimFromMount: resizeAt! - renderedAt,
        revealFromMount:
          revealedAt === undefined ? null : revealedAt - renderedAt,
        adoptionToClaimMilliseconds:
          claimAt === undefined || adoptedAt === undefined
            ? null
            : claimAt - adoptedAt,
        viewMilliseconds: resizeAt === undefined ? null : resizeAt - attachedAt,
        wireMilliseconds: claimAt === undefined ? null : claimAt - attachedAt,
      });
      expect(sendResize.mock.calls.some((args) => args[2] === true)).toBe(true);
      expect(resizeAt).toBeDefined();
      expect(resizeAt! - renderedAt).toBeLessThanOrEqual(100);
      if (cacheMode === "miss") expect(claimAt).toBe(resizeAt);
      expect(claimAt! - attachedAt).toBeLessThanOrEqual(100);
      const measured = { type: "resize", cols, rows: 36, claim: true };
      expect(claims).toEqual(
        cacheMode === "mismatch"
          ? [
              { type: "resize", cols: cachedCols, rows: 36, claim: true },
              measured,
            ]
          : [measured],
      );
      expect(readCachedTerminalGrid(session.id)).toEqual({ cols, rows: 36 });
    },
  );
});
