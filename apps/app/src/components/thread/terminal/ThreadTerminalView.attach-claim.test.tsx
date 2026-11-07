// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import * as terminalMarks from "@/lib/terminal-performance";
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
import { readTerminalFontMetrics } from "./terminal-font";
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
  it.each([
    ...[44, 125].flatMap((cols) =>
      ["ready", "pending", "delayed"].flatMap((pendingScreen) =>
        ["miss", "match", "mismatch"].map((cacheMode) => ({
          cols,
          pendingScreen,
          cacheMode,
          rendererMode: "dom",
          layoutShift: false,
        })),
      ),
    ),
    ...[44, 125].flatMap((cols) =>
      ["webgl", "failed", "late", "unobserved"].flatMap((rendererMode) =>
        (rendererMode === "webgl" ? [false, true] : [false]).map(
          (layoutShift) => ({
            cols,
            pendingScreen: "pending",
            cacheMode: "miss",
            rendererMode,
            layoutShift,
          }),
        ),
      ),
    ),
  ])(
    "claims the fitted $cols-column grid (screen: $pendingScreen, cache: $cacheMode, renderer: $rendererMode, layout shift: $layoutShift)",
    async ({ cols, pendingScreen, cacheMode, rendererMode, layoutShift }) => {
      let layoutMoved = false;
      const finalCols = cols + (layoutShift ? 3 : 0);
      const stages = new Map<string, number>();
      vi.spyOn(terminalMarks, "markTerminalPerformance").mockImplementation(
        (name) => {
          if (!stages.has(name)) stages.set(name, Date.now());
        },
      );
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
      let webglActive = false;
      let rendererFailedAt: number | undefined;
      vi.spyOn(rendererModule, "loadTerminalWebglRenderer").mockImplementation(
        (_terminal, _create, options) => ({
          get renderer() {
            return webglActive ? "webgl" : "dom";
          },
          get initialAttemptComplete() {
            return webglActive || rendererFailedAt !== undefined;
          },
          setVisible: (visible) => {
            if (rendererMode === "failed") {
              if (visible && rendererFailedAt === undefined) {
                rendererFailedAt = Date.now();
                options?.onRendererChange?.("dom");
              }
              return;
            }
            if (visible && !webglActive) {
              webglActive = true;
              options?.onRendererChange?.("webgl");
            }
          },
          dispose: vi.fn(),
        }),
      );
      const observeVisibility = rendererModule.observeTerminalWebglVisibility;
      vi.spyOn(
        rendererModule,
        "observeTerminalWebglVisibility",
      ).mockImplementation((args) => {
        if (rendererMode === "unobserved") {
          args.root.style.visibility = "hidden";
          const observer = observeVisibility(args);
          args.root.style.visibility = "visible";
          observer.sync();
          return observer;
        }
        const sync = () => args.renderer.setVisible(args.isPanelOpen());
        sync();
        return { sync, dispose: vi.fn() };
      });
      vi.spyOn(
        rendererModule,
        "loadOptionalTerminalWebglAddon",
      ).mockImplementation(() =>
        rendererMode === "dom"
          ? Promise.resolve(null)
          : new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    WebglAddon: class {
                      activate() {}
                      dispose() {}
                      onContextLoss() {
                        return { dispose() {} };
                      }
                    },
                  }),
                rendererMode === "late" ? 400 : 80,
              ),
            ),
      );
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
        () => ({
          cols:
            (layoutMoved ? finalCols : cols) -
            (rendererMode === "webgl" && !webglActive ? 2 : 0),
          rows: 36,
        }),
      );
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(() => ({
        width: layoutMoved ? 400 : 354,
        height: 504,
        top: 0,
        left: 0,
        right: layoutMoved ? 400 : 354,
        bottom: 504,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));
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
        .mockImplementation(function (
          this: TerminalWebSocketTransport,
          cols,
          rows,
          claim,
        ) {
          if (claim) resizeAt ??= Date.now();
          originalSendResize.call(this, cols, rows, claim);
        });
      const session = makeTerminalSession({
        id: "term_existing_client_grid",
        threadId: null,
        status: "running",
        ...(cacheMode === "match" || rendererMode !== "dom"
          ? { cols, rows: 36 }
          : {}),
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
        rememberTerminalGrid(
          session.id,
          document.createElement("div"),
          readTerminalFontMetrics().fontSize,
          {
            cols: cachedCols,
            rows: 36,
          },
        );
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
        const frame = JSON.parse(data);
        if (rendererMode === "webgl" && frame.type === "resize")
          queueMicrotask(() =>
            socket.receive({
              type: "session-updated",
              session: { ...session, cols: frame.cols, rows: frame.rows },
            }),
          );
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
      if (cacheMode === "miss") expect(claimAt).toBeUndefined();
      else expect(claimAt).toBe(attachedAt);
      expect(startTransport).not.toHaveBeenCalled();
      if (cacheMode !== "miss") await vi.advanceTimersByTimeAsync(700);
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
      if (rendererMode === "webgl") expect(webglActive).toBe(false);
      expect(
        document.querySelector('[data-replay-held="true"]'),
      ).not.toBeNull();
      if (cacheMode === "miss") expect(claimAt).toBeUndefined();
      Object.assign(fonts, { status: "loaded" });
      fontsReady?.();
      if (layoutShift)
        setTimeout(() => {
          layoutMoved = true;
        }, 56);
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
      if (cacheMode === "match" || rendererMode !== "dom") {
        expect(document.querySelector("[data-terminal-restoring]")).toBeNull();
        expect(
          document.querySelector('[data-replay-held="false"]'),
        ).not.toBeNull();
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: "ack",
          nextSeq: 1,
        });
        if (rendererMode === "failed") {
          expect(rendererFailedAt! - renderedAt).toBe(80);
          expect(revealedAt! - rendererFailedAt!).toBeLessThanOrEqual(64);
          expect(revealedAt! - renderedAt).toBeLessThanOrEqual(80 + 64);
        } else
          expect(revealedAt! - renderedAt).toBeLessThanOrEqual(
            rendererMode === "late" || rendererMode === "unobserved"
              ? 200
              : rendererMode === "webgl"
                ? 150
                : 64,
          );
        expect(stages.get("terminal-replay-revealed")).toBeDefined();
        expect(
          stages.get("terminal-replay-revealed")! -
            stages.get("terminal-fitted-grid-revealed")!,
        ).toBe(0);
        expect(
          stages.get("terminal-first-fitted-grid-claimed")!,
        ).toBeLessThanOrEqual(stages.get("terminal-replay-revealed")!);
        expect(stages.has("terminal-replay-preview-open-start")).toBe(false);
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
      expect(resizeAt! - renderedAt).toBeLessThanOrEqual(
        rendererMode === "late" || rendererMode === "unobserved" ? 200 : 150,
      );
      if (cacheMode === "miss") expect(claimAt).toBe(resizeAt);
      if (rendererMode === "dom")
        expect(claimAt! - renderedAt).toBeLessThanOrEqual(100);
      if (rendererMode === "failed") {
        expect(claimAt! - rendererFailedAt!).toBeLessThanOrEqual(64);
        expect(claimAt! - renderedAt).toBeLessThanOrEqual(80 + 64);
      }
      if (rendererMode !== "dom")
        expect(claimAt! - renderedAt).toBeLessThanOrEqual(
          (rendererMode === "late" || rendererMode === "unobserved"
            ? 150
            : 80) + (layoutShift ? 16 : 0),
        );
      const measured = {
        type: "resize",
        cols: finalCols,
        rows: 36,
        claim: true,
      };
      if (cacheMode !== "miss") {
        expect(stages.has("terminal-cached-grid-hit")).toBe(
          cacheMode === "match",
        );
        expect(stages.has("terminal-cached-grid-miss")).toBe(
          cacheMode === "mismatch",
        );
      }
      expect(claims).toEqual(
        cacheMode === "mismatch"
          ? [
              { type: "resize", cols: cachedCols, rows: 36, claim: true },
              measured,
            ]
          : [measured],
      );
      if (rendererMode === "late" || rendererMode === "unobserved")
        expect(webglActive).toBe(false);
      expect(readCachedTerminalGrid(session.id)).toEqual({
        cols: finalCols,
        rows: 36,
      });
    },
  );
});
