// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import * as rendererModule from "./terminal-webgl-renderer";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createTerminalGridMarker } from "@bb/domain";
import { TerminalWebSocketTransport } from "@bb/client-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitForReadiness,
  waitForReadinessCondition,
} from "./ThreadTerminalView.terminal-focus-test-utils";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";

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
      experimental_setDefaultColors: vi.fn().mockResolvedValue(undefined),
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

describe("ThreadTerminalView terminal visibility and panel", () => {
  it("refreshes the fitted grid when DOM fallback resolves after the renderer deadline", async () => {
    const focusGuard = render(<button>Other input</button>);
    focusGuard.getByRole("button").focus();
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    let finishRenderer!: (value: null) => void;
    vi.spyOn(rendererModule, "loadOptionalTerminalWebglAddon").mockReturnValue(
      new Promise<null>((resolve) => {
        finishRenderer = resolve;
      }),
    );
    for (const dimension of ["clientWidth", "offsetWidth"] as const) {
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 8
            : 354;
        },
      );
    }
    for (const dimension of ["clientHeight", "offsetHeight"] as const) {
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 18
            : 504;
        },
      );
    }
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
    let cols = 132;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols, rows: 39 }),
    );
    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_late_dom",
              threadId: null,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    const sizes = () =>
      testState.socketMessages
        .map((value) => JSON.parse(value) as { type: string; cols: number })
        .filter((value) => value.type === "resize");
    await waitForReadinessCondition(
      () => expect(sizes().at(-1)?.cols).toBe(132),
      "renderer deadline did not send initial grid",
    );
    cols = 44;
    finishRenderer(null);
    await waitForReadinessCondition(
      () => expect(sizes().at(-1)?.cols).toBe(44),
      "late fallback did not send the phone grid",
    );
    expect(sizes().map((size) => size.cols)).toEqual([132, 44]);
  });

  it.each([
    {
      name: "phone with a stale live marker",
      reconnect: false,
      lateRenderer: null,
      fit: { cols: 44, rows: 40 },
      attached: { cols: 125, rows: 44 },
      live: { cols: 125, rows: 44 },
    },
    {
      name: "phone with the current live marker",
      reconnect: false,
      lateRenderer: null,
      fit: { cols: 44, rows: 40 },
      attached: { cols: 125, rows: 44 },
      live: { cols: 44, rows: 40 },
    },
    {
      name: "desktop after a phone client",
      reconnect: false,
      lateRenderer: null,
      fit: { cols: 125, rows: 44 },
      attached: { cols: 44, rows: 40 },
      live: { cols: 125, rows: 44 },
    },
    ...(["dom", "webgl"] as const).map((lateRenderer) => ({
      name: `phone late ${lateRenderer} settle`,
      reconnect: false,
      fit: { cols: 44, rows: 40 },
      attached: { cols: 125, rows: 44 },
      live: { cols: 44, rows: 40 },
      lateRenderer,
    })),
    {
      name: "desktop after an empty reconnect with pending replay writes",
      reconnect: true,
      fit: { cols: 132, rows: 41 },
      attached: { cols: 132, rows: 41 },
      live: { cols: 132, rows: 41 },
      lateRenderer: null,
    },
  ])(
    "applies the accepted grid to $name before pending replay writes drain",
    async ({ fit, attached, live, lateRenderer, reconnect }) => {
      const focusGuard = render(<button>Other input</button>);
      focusGuard.getByRole("button").focus();
      vi.stubGlobal("WebSocket", TestTerminalSocket);
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        measureText: (text: string) => ({ width: text.length * 8 }),
      } as unknown as CanvasRenderingContext2D);
      let finishRenderer:
        | ((
            module: Awaited<
              ReturnType<typeof rendererModule.loadOptionalTerminalWebglAddon>
            >,
          ) => void)
        | undefined;
      const loadRenderer = vi.spyOn(
        rendererModule,
        "loadOptionalTerminalWebglAddon",
      );
      if (lateRenderer === null) loadRenderer.mockResolvedValue(null);
      else {
        loadRenderer.mockReturnValue(
          new Promise((resolve) => {
            finishRenderer = resolve;
          }),
        );
        sessionStorage.setItem(
          "bb:terminal-viewport:term_existing_client_grid",
          JSON.stringify({
            distanceFromTail: 0,
            lineOffset: 0,
            outputSequence: 0,
          }),
        );
      }

      for (const dimension of ["clientWidth", "offsetWidth"] as const) {
        vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
          function (this: HTMLElement) {
            return this.classList.contains("xterm-char-measure-element")
              ? 8
              : 354;
          },
        );
      }
      for (const dimension of ["clientHeight", "offsetHeight"] as const) {
        vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
          function (this: HTMLElement) {
            return this.classList.contains("xterm-char-measure-element")
              ? 18
              : 504;
          },
        );
      }
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
      let fitted = fit;
      let mountedContainer: HTMLElement | undefined;
      let fitMeasurements = 0;
      const notifyContainerResize: Array<() => void> = [];
      if (reconnect) {
        vi.stubGlobal(
          "ResizeObserver",
          class {
            constructor(private readonly callback: ResizeObserverCallback) {}
            observe(target: Element) {
              if (target.hasAttribute("data-terminal-renderer")) {
                notifyContainerResize.push(() =>
                  this.callback(
                    [
                      {
                        target,
                        contentRect: target.getBoundingClientRect(),
                      } as ResizeObserverEntry,
                    ],
                    this,
                  ),
                );
              }
            }
            disconnect() {}
            unobserve() {}
          },
        );
      }
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
        () => {
          fitMeasurements += 1;
          const status = mountedContainer?.querySelector("[role=status]");
          return {
            cols: fitted.cols,
            rows:
              fitted.rows -
              (reconnect &&
              status &&
              getComputedStyle(status).position !== "absolute"
                ? 2
                : 0),
          };
        },
      );
      const session = makeTerminalSession({
        id: "term_existing_client_grid",
        ...attached,
        threadId: null,
        status: "running",
      });
      const mounted = render(
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadTerminalView
              autoFocus={false}
              isPanelOpen
              session={session}
            />
          </AppCommandProvider>
        </MemoryRouter>,
      );
      const sizes = () =>
        testState.socketMessages
          .map((raw) => JSON.parse(raw))
          .filter((message) => message.type === "resize");
      mountedContainer = mounted.container;
      await waitFor(
        () => {
          expect(sizes()).toHaveLength(1);
          expect(sizes()[0]).toMatchObject(fit);
        },
        { timeout: 10_000 },
      );
      let socket = testState.sockets[0];
      if (!socket) throw new Error("terminal socket is missing");
      const renderer = mounted.container.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      );
      expect(renderer?.style.opacity).toBe("0");
      socket.receive({
        type: "attached",
        session,
        replayStartSeq: 0,
        nextSeq: 1,
      });
      let holdWrites = true;
      const pendingWrites: Array<() => void> = [];
      const write = Terminal.prototype.write;
      vi.spyOn(Terminal.prototype, "write").mockImplementation(
        function (this: Terminal, data, callback) {
          write.call(this, data, () => {
            if (holdWrites && callback) pendingWrites.push(callback);
            else callback?.();
          });
        },
      );
      try {
        socket.receive({
          type: "output",
          chunk: {
            seq: 0,
            dataBase64: btoa(
              createTerminalGridMarker(attached) +
                "replay\r\n" +
                createTerminalGridMarker({ cols: 44, rows: 38 }),
            ),
          },
        });
        await waitForReadinessCondition(
          () => expect(pendingWrites.length).toBeGreaterThan(0),
          "historical replay did not reach the deferred parser callback",
        );
        if (reconnect) {
          testState.deferSocketOpen = true;
          socket.disconnect();
          await waitForReadinessCondition(
            () => expect(testState.sockets).toHaveLength(2),
            "reconnect socket was not created",
          );
          socket = testState.sockets[1]!;
          await waitForReadinessCondition(
            () =>
              expect(
                mounted.container.querySelector("[role=status]")?.textContent,
              ).toBe("Reconnecting…"),
            "reconnect status was not shown",
          );
          const measurements = fitMeasurements;
          const previousSizes = sizes();
          for (const notify of notifyContainerResize) notify();
          await waitForReadinessCondition(
            () => expect(fitMeasurements).toBeGreaterThan(measurements),
            "terminal did not remeasure with the reconnect status",
          );
          expect(renderer?.dataset.fitGridRows).toBe(String(fit.rows));
          expect(sizes()).toEqual(previousSizes);
          socket.open();
          socket.receive({
            type: "attached",
            session: { ...session, rows: fit.rows - 2 },
            replayStartSeq: 1,
            nextSeq: 1,
          });
          expect(renderer?.dataset.replayHeld).toBe("false");
          expect(renderer?.dataset.renderGridRows).toBe(String(fit.rows - 2));
        }
        socket.receive({ type: "features", resizeAcks: true });
        socket.receive({
          type: "session-updated",
          session: { ...session, ...fit },
        });
        socket.receive({ type: "resize-applied", seq: 1 });
        await waitFor(
          () => {
            expect(renderer?.dataset.renderGridCols).toBe(String(fit.cols));
            expect(renderer?.dataset.renderGridRows).toBe(String(fit.rows));
            expect(renderer?.dataset.ptyGridCols).toBe(String(fit.cols));
            expect(renderer?.dataset.ptyGridRows).toBe(String(fit.rows));
            expect(renderer?.dataset.replayHeld).toBe(
              reconnect ? "false" : "true",
            );
          },
          { timeout: 1000 },
        );
      } finally {
        if (lateRenderer !== null)
          fitted = { cols: fit.cols, rows: fit.rows - 2 };
        holdWrites = false;
        for (const callback of pendingWrites.splice(0)) callback();
      }
      socket.receive({
        type: "output",
        chunk: {
          seq: 1,
          dataBase64: btoa(createTerminalGridMarker(live) + "tail\r\n"),
        },
      });
      await waitForReadinessCondition(
        () =>
          expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
            type: "ack",
            nextSeq: 2,
          }),
        "replay and buffered live output were not parsed",
      );
      if (lateRenderer !== null) {
        await waitForReadinessCondition(
          () => expect(renderer?.dataset.replayHeld).toBe("false"),
          "replay did not complete before late renderer settle",
        );
        fitted = fit;
        if (lateRenderer === "webgl") {
          vi.spyOn(rendererModule, "loadTerminalWebglRenderer").mockReturnValue(
            {
              renderer: "webgl",
              initialAttemptComplete: true,
              setVisible() {},
              dispose() {},
            },
          );
          finishRenderer?.({
            WebglAddon: class {
              activate() {}
              dispose() {}
              onContextLoss() {
                return { dispose() {} };
              }
            },
          });
        } else finishRenderer?.(null);
        await waitForReadinessCondition(
          () => expect(renderer?.dataset.fitGridRows).toBe(String(fit.rows)),
          "late renderer did not refresh fit rows",
        );
        await waitForReadinessCondition(
          () => expect(sizes().at(-1)).toMatchObject(fit),
          "late settle sent a stale fitted resize",
        );
      }
      await waitForReadinessCondition(() => {
        expect(renderer?.dataset.replayHeld).toBe("false");
        expect(renderer?.dataset.ptyGridCols).toBe(String(fit.cols));
        expect(renderer?.dataset.ptyGridRows).toBe(String(fit.rows));
        expect(renderer?.dataset.renderGridCols).toBe(String(fit.cols));
        expect(renderer?.dataset.renderGridRows).toBe(String(fit.rows));
      }, "buffered output replaced the accepted grid");
      socket.receive({
        type: "session-updated",
        session: { ...session, cols: 41, rows: 36 },
      });
      await waitForReadinessCondition(() => {
        expect(renderer?.dataset.ptyGridCols).toBe("41");
        expect(renderer?.dataset.ptyGridRows).toBe("36");
        expect(renderer?.dataset.renderGridCols).toBe("41");
        expect(renderer?.dataset.renderGridRows).toBe("36");
      }, "a remote client size update was suppressed after a grid marker");
    },
  );

  it("sends exactly one fitted resize when WebGL settles before the deadline", async () => {
    const focusGuard = render(<button>Other input</button>);
    focusGuard.getByRole("button").focus();
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
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
    vi.spyOn(rendererModule, "loadTerminalWebglRenderer").mockReturnValue({
      renderer: "webgl",
      initialAttemptComplete: true,
      setVisible() {},
      dispose() {},
    });
    for (const dimension of ["clientWidth", "offsetWidth"] as const) {
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 8
            : 354;
        },
      );
    }
    for (const dimension of ["clientHeight", "offsetHeight"] as const) {
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 18
            : 504;
        },
      );
    }
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
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 44,
      rows: 39,
    });
    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_webgl_single_resize",
              threadId: null,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    const sizes = () =>
      testState.socketMessages
        .map(
          (value) =>
            JSON.parse(value) as { type: string; cols: number; rows: number },
        )
        .filter((value) => value.type === "resize");
    await waitForReadinessCondition(
      () => expect(sizes().length).toBeGreaterThan(0),
      "WebGL did not send fitted grid",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sizes()).toEqual([expect.objectContaining({ cols: 44, rows: 39 })]);
  });

  it.each(["dom", "webgl"] as const)(
    "paints one symmetric gutter without losing a second gutter of columns before its single %s size claim",
    async (renderer) => {
      vi.stubGlobal("WebSocket", TestTerminalSocket);
      const style = document.createElement("style");
      style.textContent = `.px-2 { padding-left: 8px; padding-right: 8px; }
        .pl-2 { padding-left: 8px; }
        .bg-sidebar { background-color: var(--sidebar); }
        [data-terminal-grid-cache-id] { width: 354px; height: 504px; }
        :root { --sidebar: rgb(30, 40, 50); --ink: rgb(220, 230, 240); }`;
      document.body.append(style);
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        measureText: (text: string) => ({ width: text.length * 8 }),
        clearRect() {},
        fillRect() {},
        getImageData: () => ({
          data: new Uint8ClampedArray([30, 40, 50, 255]),
        }),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(
        rendererModule,
        "loadOptionalTerminalWebglAddon",
      ).mockResolvedValue(null);
      vi.spyOn(rendererModule, "loadTerminalWebglRenderer").mockReturnValue({
        renderer,
        initialAttemptComplete: true,
        setVisible() {},
        dispose() {},
      });
      for (const dimension of ["clientWidth", "offsetWidth"] as const)
        vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
          function (this: HTMLElement) {
            return this.classList.contains("xterm-char-measure-element")
              ? 8 * 32
              : 354;
          },
        );
      for (const dimension of ["clientHeight", "offsetHeight"] as const)
        vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
          function (this: HTMLElement) {
            return this.classList.contains("xterm-char-measure-element")
              ? 18
              : 504;
          },
        );
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 354, 504),
      );
      const terminals: Terminal[] = [];
      const open = Terminal.prototype.open;
      vi.spyOn(Terminal.prototype, "open").mockImplementation(
        function (this: Terminal, element) {
          terminals.push(this);
          open.call(this, element);
        },
      );
      const view = render(
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadTerminalView
              autoFocus={false}
              isPanelOpen
              session={makeTerminalSession({
                id: `term_padding_${renderer}`,
                threadId: null,
                status: "running",
              })}
            />
          </AppCommandProvider>
        </MemoryRouter>,
      );
      const sizes = () =>
        testState.socketMessages
          .map(
            (value) =>
              JSON.parse(value) as { type: string; cols: number; rows: number },
          )
          .filter((value) => value.type === "resize");
      await waitForReadinessCondition(
        () => expect(sizes()).toHaveLength(1),
        "padding grid was not claimed",
      );
      const terminal = terminals[0]!;
      const host = view.container.querySelector<HTMLElement>(
        "[data-terminal-grid-cache-id]",
      )!;
      const paneStyle = getComputedStyle(host.parentElement!);
      expect(parseFloat(paneStyle.paddingLeft || "0")).toBe(0);
      expect(parseFloat(paneStyle.paddingRight || "0")).toBe(0);
      expect(getComputedStyle(terminal.element!).backgroundColor).toBe(
        "rgb(30, 40, 50)",
      );
      const terminalStyle = getComputedStyle(terminal.element!);
      const hostStyle = getComputedStyle(host);
      expect(
        parseFloat(hostStyle.paddingLeft || "0") +
          parseFloat(terminalStyle.paddingLeft || "0"),
      ).toBe(8);
      expect(
        parseFloat(hostStyle.paddingRight || "0") +
          parseFloat(terminalStyle.paddingRight || "0"),
      ).toBe(8);
      expect(terminalStyle.paddingLeft).toBe("8px");
      expect(terminalStyle.paddingRight).toBe("8px");
      const cell = terminal.dimensions!.css.cell;
      const scrollbar = terminal.options.scrollbar?.width ?? 14;
      const expected = {
        cols: Math.floor((354 - 16 - scrollbar) / cell.width),
        rows: Math.floor(504 / cell.height),
      };
      expect(sizes()).toEqual([expect.objectContaining(expected)]);
      const socket = testState.sockets[0]!;
      socket.receive({
        type: "attached",
        session: makeTerminalSession({
          id: `term_padding_${renderer}`,
          threadId: null,
          status: "running",
          ...expected,
        }),
        replayStartSeq: 0,
        nextSeq: 1,
      });
      socket.receive({
        type: "output",
        chunk: {
          seq: 0,
          dataBase64: btoa(createTerminalGridMarker(expected) + "padded\r\n"),
        },
      });
      socket.receive({ type: "replay-complete", nextSeq: 1 });
      await waitForReadinessCondition(
        () =>
          expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(
            expected,
          ),
        "render grid did not match accepted PTY grid",
      );
      expect(sizes()).toHaveLength(1);
      view.unmount();
      style.remove();
    },
  );

  it("keeps the app identity when the server echoes it after terminal attach", async () => {
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
                contentRect: { width: 390, height: 700 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 20,
    });

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term-late-app-token",
              threadId: null,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(1),
      "initial terminal socket URL was not created within 5000 ms",
    );
    const initialToken = new URL(
      testState.socketUrls[0] ?? "ws://localhost",
    ).searchParams.get("handoffOwnerToken");
    expect(initialToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    wsManager.handleIncomingMessage(
      JSON.stringify({
        type: "device-handoff-client-token",
        token: initialToken,
      }),
    );

    expect(testState.socketUrls).toHaveLength(1);

    testState.sockets[0]?.disconnect();
    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(2),
      "terminal socket did not reconnect within 5000 ms",
    );
    expect(
      new URL(testState.socketUrls[1] ?? "ws://localhost").searchParams.get(
        "handoffOwnerToken",
      ),
    ).toBe(initialToken);
  });

  it.each([
    {
      path: "desktop terminal tab",
      threadId: null,
      compact: false,
    },
    {
      path: "split-pane terminal",
      threadId: "thr_split_terminal",
      compact: false,
    },
    {
      path: "phone right-panel terminal tab",
      threadId: null,
      compact: true,
    },
    {
      path: "thread terminal with a threadless origin",
      threadId: null,
      compact: false,
    },
  ])("attaches the $path with its owning app token", async (view) => {
    wsManager.handleIncomingMessage(
      JSON.stringify({
        type: "device-handoff-client-token",
        token: "0123456789abcdefghij_-",
      }),
    );
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
                contentRect: { width: 390, height: 700 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve(): void {}
      },
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: view.compact && query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 20,
    });
    const token = `view-path-owner-${view.path.replaceAll(" ", "-")}`;
    wsManager.handleIncomingMessage(
      JSON.stringify({ type: "device-handoff-client-token", token }),
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: `term-${view.path.replaceAll(" ", "-")}`,
              threadId: view.threadId,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitForReadinessCondition(
      () => expect(testState.socketUrls).toHaveLength(1),
      "terminal socket URL was not created within 5000 ms",
    );
    const url = new URL(testState.socketUrls[0] ?? "ws://localhost");
    expect(url.pathname).toBe(
      `/ws/terminals/term-${view.path.replaceAll(" ", "-")}`,
    );
    expect(url.searchParams.get("handoffOwnerToken")).toBe(token);
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages
          .map((message) => JSON.parse(message))
          .some(
            (message) =>
              message.type === "visibility" && message.visible === true,
          ),
      ).toBe(true);
    }, "terminal visibility was not reported within 5000 ms");
  });

  it("keeps attention on open until a terminal keystroke", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(108);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(90);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 12,
      rows: 5,
    });
    const session = makeTerminalSession({
      id: "term_attention",
      attention: { at: 10, kind: "bell", seq: 3 },
    });
    const updatedSession = { ...session, attention: null };
    const onSessionChange = vi.fn();
    testState.clearAttention.mockResolvedValue(updatedSession);

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 288
          : 108;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 90;
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            onSessionChange={onSessionChange}
            session={session}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    expect(testState.clearAttention).not.toHaveBeenCalled();
    await waitForReadinessCondition(() => {
      expect(document.querySelector(".xterm-helper-textarea")).not.toBeNull();
    }, "terminal did not mount");
    expect(testState.clearAttention).not.toHaveBeenCalled();
    await waitForReadinessCondition(() => {
      expect(testState.sockets).toHaveLength(1);
      expect(testState.sockets[0]?.readyState).toBe(TestTerminalSocket.OPEN);
    }, "terminal socket did not open");
    testState.sockets[0]!.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    await waitForReadinessCondition(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent === "Fit to this screen",
        ),
      ).toBe(true);
    }, "fit control did not become ready");
    const fitControl = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Fit to this screen",
    );
    expect(fitControl).toBeDefined();
    expect(fitControl?.getAttribute("data-compact-touch")).toBe("code");
    fireEvent.click(fitControl!);
    expect(testState.clearAttention).not.toHaveBeenCalled();
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.some((raw) => {
          const message = JSON.parse(raw);
          return message.type === "resize" && message.claim === true;
        }),
      ).toBe(true);
    }, "fit control did not claim the existing resize path");
    fireEvent.keyDown(document.querySelector(".xterm-helper-textarea")!, {
      key: "a",
      keyCode: 65,
    });
    await waitForReadinessCondition(() => {
      expect(testState.clearAttention).toHaveBeenCalledWith({
        terminalId: session.id,
      });
      expect(onSessionChange).toHaveBeenCalledWith(updatedSession);
    }, "terminal attention was not cleared within 5000 ms");
  });

  it("reports hidden visibility when its panel closes while the document stays visible", async () => {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(108);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(90);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(108);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(90);

    const props = {
      autoFocus: false,
      isPanelOpen: true,
      session: makeTerminalSession({ id: "term_panel_visibility" }),
    };
    const view = render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView {...props} />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: true });
    });
    view.rerender(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView {...props} isPanelOpen={false} />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: false });
    });
  });

  it.each([
    {
      startsHidden: false,
      beforeAttach: true,
      expireHold: false,
      name: "holds live native grid before attach",
    },
    {
      startsHidden: true,
      beforeAttach: true,
      expireHold: false,
      name: "holds live native grid before attach at zero width",
    },
    {
      startsHidden: false,
      beforeAttach: false,
      expireHold: false,
      name: "keeps revealed native grid visible while resizing",
    },
    {
      startsHidden: false,
      beforeAttach: true,
      expireHold: true,
      name: "releases the native grid hold when fitting never succeeds",
    },
  ])("$name", async ({ startsHidden, beforeAttach, expireHold }) => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    let paneWidth = startsHidden ? 0 : 1280;
    const notifySize: Array<() => void> = [];
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private active = true;
        constructor(private readonly callback: ResizeObserverCallback) {}

        disconnect(): void {
          this.active = false;
        }

        observe(target: Element): void {
          const notify = () =>
            this.active &&
            this.callback(
              [
                {
                  target,
                  contentRect: { width: paneWidth, height: 504 },
                } as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            );
          notifySize.push(notify);
          notify();
        }

        unobserve(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 9
          : paneWidth;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function clientWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 9
          : paneWidth;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function clientHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element") ? 18 : 504;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        return new DOMRect(
          0,
          0,
          this.classList.contains("xterm-screen") ? 1280 : this.clientWidth,
          this.clientHeight,
        );
      },
    );
    let fitDimensionsAvailable = false;
    let unavailableFitMeasurements = 0;
    let resolveUnavailableFitMeasurements!: () => void;
    const unavailableFitMeasurementsReady = new Promise<void>((resolve) => {
      resolveUnavailableFitMeasurements = resolve;
    });
    const propose = vi
      .spyOn(FitAddon.prototype, "proposeDimensions")
      .mockImplementation(function proposeDimensions(this: FitAddon) {
        if (fitDimensionsAvailable) {
          return paneWidth > 500
            ? { cols: 125, rows: 41 }
            : { cols: 44, rows: 38 };
        }
        unavailableFitMeasurements += 1;
        if (unavailableFitMeasurements === 2) {
          resolveUnavailableFitMeasurements();
        }
        return undefined;
      });

    const session = makeTerminalSession({
      id: "term_delayed_native_fit",
      status: "running",
      cols: 120,
      rows: 36,
    });
    testState.deferSocketOpen = true;
    const mounted = render(
      <MemoryRouter>
        <AppCommandProvider>
          <div data-native-terminal-thread="codex">
            <ThreadTerminalView
              autoFocus={false}
              isPanelOpen
              attentionShownAsBanner
              session={session}
            />
          </div>
        </AppCommandProvider>
      </MemoryRouter>,
    );
    if (!startsHidden)
      await waitForReadiness(
        unavailableFitMeasurementsReady,
        "fit was not deferred",
      );
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "socket missing",
    );
    const socket = testState.sockets[0]!;

    const renderer = mounted.container.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    await waitForReadinessCondition(
      () => expect(renderer.dataset.renderGridCols).toBe("80"),
      "terminal did not mount at the default renderer grid",
    );
    if (expireHold) {
      expect(renderer.dataset.replayHeld).toBe("true");
      expect(renderer.style.opacity).toBe("0");
      const timeout = timeouts.mock.calls.find(
        ([, delay]) => delay === 15_000,
      )?.[0];
      if (typeof timeout !== "function")
        throw new Error("hold timeout missing");
      act(() => timeout());
      expect(renderer.dataset.replayHeld).toBe("false");
      expect(renderer.style.opacity).toBe("");
      return;
    }
    if (!startsHidden) {
      fitDimensionsAvailable = true;
      for (const notify of notifySize) notify();
      fireEvent(window, new Event("resize"));
      await waitForReadinessCondition(
        () => expect(renderer.dataset.fitGridCols).toBe("125"),
        "first fit was not measured before attach",
      );
    }
    expect(renderer.dataset.renderGridCols).toBe("80");
    expect(renderer.dataset.renderGridRows).toBe("24");
    expect(renderer.dataset.ptyGridCols).toBe("120");
    expect(renderer.dataset.ptyGridRows).toBe("36");
    if (beforeAttach) {
      expect(renderer.dataset.replayHeld).toBe("true");
      expect(renderer.style.opacity).toBe("0");
    }
    socket.open();
    await socket.opened;
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: startsHidden ? 0 : 1,
    });
    if (!startsHidden) {
      socket.receive({
        type: "output",
        chunk: { seq: 0, dataBase64: btoa("restored output\r\n") },
      });
      await waitForReadinessCondition(() => {
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: "ack",
          nextSeq: 1,
        });
      }, "replay did not drain");
    } else {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(propose).not.toHaveBeenCalled();
    }
    expect(renderer.dataset.replayHeld).toBe("true");
    paneWidth = 1280;
    fitDimensionsAvailable = true;
    for (const notify of notifySize) notify();
    fireEvent(window, new Event("resize"));
    if (startsHidden) expect(testState.sockets).toHaveLength(1);
    let claimed: { cols: number; rows: number } | undefined;
    await waitForReadinessCondition(() => {
      claimed = socket.sent
        .map((raw) => JSON.parse(raw))
        .find((message) => message.type === "resize" && message.claim === true);
      expect(claimed).toBeDefined();
      expect(claimed?.cols).toBe(125);
    }, "fitted resize was not claimed");
    await waitForReadinessCondition(() => {
      expect(renderer.dataset.renderGridCols).toBe("125");
      expect(renderer.dataset.renderGridRows).toBe("41");
    }, "hidden terminal was not prepared while awaiting the PTY echo");
    expect(renderer.dataset.replayHeld).toBe("true");
    expect(renderer.style.opacity).toBe("0");
    const visibleGrids: string[] = [];
    const heldObserver = new MutationObserver(() => {
      if (renderer.style.opacity !== "0") {
        visibleGrids.push(
          `${renderer.dataset.renderGridCols}x${renderer.dataset.renderGridRows}`,
        );
      }
    });
    heldObserver.observe(renderer, { attributes: true });
    try {
      socket.receive({
        type: "session-updated",
        session: { ...session, cols: 119, rows: 40 },
      });
      await waitForReadinessCondition(() => {
        expect(renderer.dataset.renderGridCols).toBe("119");
        expect(renderer.dataset.renderGridRows).toBe("40");
      }, "terminal did not lay out at the different PTY echo");
      expect(renderer.dataset.replayHeld).toBe("true");
      expect(renderer.style.opacity).toBe("0");
      expect(visibleGrids).toEqual([]);
    } finally {
      heldObserver.disconnect();
    }
    socket.receive({
      type: "session-updated",
      session: { ...session, ...claimed },
    });
    await waitForReadinessCondition(() => {
      expect(renderer.dataset.renderGridCols).toBe(
        renderer.dataset.fitGridCols,
      );
      expect(renderer.dataset.renderGridRows).toBe(
        renderer.dataset.fitGridRows,
      );
      expect(renderer.dataset.replayHeld).toBe("false");
    }, "fitted replay was not revealed");
    expect(
      socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.type === "resize"),
    ).toEqual([{ type: "resize", ...claimed, claim: true }]);
    if (beforeAttach) return;
    expect(renderer.dataset.renderGridCols).toBe("125");
    expect(renderer.dataset.renderGridRows).toBe("41");
    expect(renderer.style.opacity).toBe("");
    const opacities: string[] = [];
    const observer = new MutationObserver(() =>
      opacities.push(renderer.style.opacity),
    );
    observer.observe(renderer, {
      attributes: true,
      attributeFilter: ["style", "data-replay-held"],
    });
    try {
      paneWidth = 390;
      for (const notify of notifySize) notify();
      await waitForReadinessCondition(() => {
        expect(renderer.dataset.fitGridCols).toBe("44");
        expect(renderer.dataset.fitGridRows).toBe("38");
      }, "phone fit was not measured");
      expect(renderer.style.opacity).toBe("");
      expect(renderer.dataset.replayHeld).toBe("false");
      expect(opacities).not.toContain("0");
      const surface = renderer.querySelector<HTMLElement>(".xterm")!;
      expect(surface.style.maxWidth).toBe("100%");
      expect(surface.style.overflow).toBe("hidden");
      expect(surface.style.transform).toBe("scale(1)");
      expect(renderer.style.overflowX).not.toBe("auto");
      expect(renderer.classList.contains("overflow-hidden")).toBe(true);
      expect(
        renderer.parentElement?.classList.contains("overflow-hidden"),
      ).toBe(true);
      socket.receive({
        type: "session-updated",
        session: { ...session, cols: 44, rows: 38 },
      });
      await waitForReadinessCondition(() => {
        expect(renderer.dataset.renderGridCols).toBe("44");
        expect(renderer.dataset.renderGridRows).toBe("38");
      }, "phone grid was not applied");
      expect(renderer.style.opacity).toBe("");
      expect(renderer.dataset.replayHeld).toBe("false");
      expect(opacities).not.toContain("0");
    } finally {
      observer.disconnect();
    }
  });

  it("waits for fit dimensions before settling the initial main-pane layout", async () => {
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
    const originalProposeDimensions = FitAddon.prototype.proposeDimensions;
    let fitDimensionsAvailable = false;
    let unavailableFitMeasurements = 0;
    let resolveUnavailableFitMeasurements!: () => void;
    const unavailableFitMeasurementsReady = new Promise<void>((resolve) => {
      resolveUnavailableFitMeasurements = resolve;
    });
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      function proposeDimensions(this: FitAddon) {
        if (fitDimensionsAvailable) {
          return originalProposeDimensions.call(this);
        }
        unavailableFitMeasurements += 1;
        if (unavailableFitMeasurements === 2) {
          resolveUnavailableFitMeasurements();
        }
        return undefined;
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_initial_main_fit_unmeasured",
              status: "running",
              cols: 120,
              rows: 36,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: true });
    }, "terminal visibility was not reported within 5000 ms");
    await waitForReadiness(
      unavailableFitMeasurementsReady,
      "initial fit dimensions were not measured while unavailable within 5000 ms",
    );
    expect(
      testState.socketMessages
        .map((message) => JSON.parse(message) as { type?: string })
        .some((message) => message.type === "resize"),
    ).toBe(false);
    fitDimensionsAvailable = true;

    await waitForReadinessCondition(() => {
      const resize = testState.socketMessages
        .map(
          (message) => JSON.parse(message) as { cols?: number; type?: string },
        )
        .find((message) => message.type === "resize");
      expect(resize).toBeDefined();
      expect(resize?.cols).toBeLessThan(120);
    }, "initial fitted resize was not sent within 5000 ms");

    const resizeFrames = () =>
      testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as {
              cols?: number;
              rows?: number;
              type?: string;
            },
        )
        .filter((message) => message.type === "resize");
    const fittedSize = resizeFrames()[0];
    if (fittedSize?.cols === undefined || fittedSize.rows === undefined) {
      throw new Error("Expected a fitted terminal size");
    }
    const visibilityState = vi.spyOn(document, "visibilityState", "get");
    visibilityState.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForReadinessCondition(() => {
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "visibility", visible: false });
    }, "terminal hidden visibility was not reported within 5000 ms");

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitForReadinessCondition(() => {
      const messages = testState.socketMessages.map(
        (message) =>
          JSON.parse(message) as {
            cols?: number;
            rows?: number;
            type?: string;
            visible?: boolean;
          },
      );
      const hiddenIndex = messages.findIndex(
        (message) => message.type === "visibility" && !message.visible,
      );
      const visibleIndex = messages.findIndex(
        (message, index) =>
          index > hiddenIndex &&
          message.type === "visibility" &&
          message.visible,
      );
      expect(hiddenIndex).toBeGreaterThanOrEqual(0);
      expect(visibleIndex).toBeGreaterThan(hiddenIndex);
      expect(
        messages
          .slice(visibleIndex + 1)
          .find(
            (message) =>
              message.type === "resize" &&
              message.cols === fittedSize.cols &&
              message.rows === fittedSize.rows,
          ),
      ).toEqual({
        type: "resize",
        cols: fittedSize.cols,
        rows: fittedSize.rows,
      });
    }, "terminal visible visibility was not restored after focus within 5000 ms");
  });
});

it.each([
  {
    device: "phone",
    width: 390,
    cols: 51,
    rows: 37,
    renderCols: 80,
    renderRows: 24,
    scale: "1",
  },
  {
    device: "desktop",
    width: 1280,
    cols: 76,
    rows: 40,
    renderCols: 80,
    renderRows: 24,
    scale: "1",
  },
])(
  "preserves exited native output layout on $device after touch focus and remount",
  async ({ width, cols, rows, renderCols, renderRows, scale }) => {
    vi.stubGlobal("innerWidth", width);
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      matches:
        query === COMPACT_VIEWPORT_QUERY
          ? width <= 767
          : matchMedia(query).matches,
    }));
    const sendResize = vi.spyOn(
      TerminalWebSocketTransport.prototype,
      "sendResize",
    );
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(374);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(526);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 357, 281),
    );
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols,
      rows,
    });
    testState.output.mockResolvedValue({
      chunks: [{ seq: 0, dataBase64: btoa("LAST-ANSWER\r\n") }],
      nextSeq: 1,
    });
    const props = {
      autoFocus: false,
      isPanelOpen: true,
      retainNativeOutput: true,
      session: makeTerminalSession({
        status: "exited",
        exitCode: 0,
        cols: 80,
        rows: 24,
      }),
    };
    for (let i = 0; i < 2; i++) {
      const view = render(
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadTerminalView {...props} />
          </AppCommandProvider>
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          view.container.querySelector("[data-terminal-renderer] .xterm"),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(testState.output).toHaveBeenCalledTimes(i + 1),
      );
      await waitFor(() =>
        expect(
          view.container.querySelector(".xterm-rows")?.textContent,
        ).toContain("LAST-ANSWER"),
      );
      await waitFor(() =>
        expect(
          view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.renderGridCols,
        ).toBe(String(renderCols)),
      );
      expect(
        view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
          ?.dataset.renderGridRows,
      ).toBe(String(renderRows));
      expect(
        view.container.querySelector<HTMLElement>(".xterm")?.dataset
          .surfaceScale,
      ).toBe(scale);
      const textarea =
        view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      textarea.focus();
      fireEvent.pointerDown(textarea, { pointerType: "touch" });
      fireEvent.pointerUp(textarea, { pointerType: "touch" });
      fireEvent(window, new Event("resize"));
      await waitFor(() =>
        expect(
          view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.style.opacity,
        ).not.toBe("0"),
      );
      expect(sendResize).not.toHaveBeenCalled();
      expect(
        testState.socketMessages.some(
          (message) => JSON.parse(message).type === "resize",
        ),
      ).toBe(false);
      view.unmount();
    }
  },
);

describe("hidden terminal output continuity", () => {
  const webglModule = {
    WebglAddon: class {
      activate() {}
      dispose() {}
      onContextLoss() {
        return { dispose() {} };
      }
    },
  };

  async function mountContinuityViewer(
    initiallyHidden = false,
    {
      rendererGrid = false,
      native = true,
      waitForReplay = true,
      terminalId = "term_hidden_continuity",
    } = {},
  ) {
    vi.stubGlobal("WebSocket", TestTerminalSocket);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    for (const dimension of ["clientWidth", "offsetWidth"] as const)
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 8
            : 800;
        },
      );
    for (const dimension of ["clientHeight", "offsetHeight"] as const)
      vi.spyOn(HTMLElement.prototype, dimension, "get").mockImplementation(
        function (this: HTMLElement) {
          return this.classList.contains("xterm-char-measure-element")
            ? 18
            : 480;
        },
      );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 480,
      top: 0,
      left: 0,
      right: 800,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const propose = vi
      .spyOn(FitAddon.prototype, "proposeDimensions")
      .mockImplementation(() => ({
        cols: rendererGrid
          ? document.querySelector<HTMLElement>("[data-terminal-renderer]")
              ?.dataset.terminalRenderer === "webgl"
            ? 98
            : 92
          : 80,
        rows: 24,
      }));
    let live: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      ...args
    ) {
      live ??= this;
      return open.apply(this, args);
    });
    const session = makeTerminalSession({
      id: terminalId,
      cols: rendererGrid ? 98 : 80,
      rows: 24,
    });
    const ui = (visible: boolean) => (
      <MemoryRouter>
        <AppCommandProvider>
          <div data-native-terminal-thread={native ? "native" : undefined}>
            <ThreadTerminalView
              session={session}
              autoFocus={false}
              isPanelOpen={visible}
            />
          </div>
        </AppCommandProvider>
      </MemoryRouter>
    );
    const view = render(ui(!initiallyHidden));
    await waitFor(() => expect(testState.sockets).toHaveLength(1));
    const socket = testState.sockets[0]!;
    await socket.opened;
    await waitFor(() => expect(live).not.toBeNull());
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("initial\r\n") },
    });
    const text = () => {
      const buffer = live?.buffer.active;
      return buffer
        ? Array.from(
            { length: buffer.length },
            (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
          ).join("\n")
        : "";
    };
    const ready = () =>
      waitForReadinessCondition(() => {
        expect(text()).toContain("initial");
        expect(
          view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
            ?.dataset.replayHeld,
        ).toBe("false");
      }, "visible terminal did not finish its initial replay");
    if (!initiallyHidden && waitForReplay) await ready();
    const visible = async (value: boolean) => {
      view.rerender(ui(value));
      await waitFor(() =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "visibility", visible: value }),
      );
    };
    return { socket, session, text, visible, view, propose, ready };
  }

  const nextFrames = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const resizeMessages = (socket: TestTerminalSocket) =>
    socket.sent
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "resize");

  it("does not fit a hidden renderer or resize the PTY across an unchanged hide/show", async () => {
    vi.spyOn(
      rendererModule,
      "loadOptionalTerminalWebglAddon",
    ).mockResolvedValue(webglModule);
    const h = await mountContinuityViewer(false, {
      rendererGrid: true,
      terminalId: "term_renderer_switch",
    });
    expect(
      h.view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
        ?.dataset.terminalRenderer,
    ).toBe("webgl");
    const sizes = resizeMessages(h.socket).length;
    const proposals = h.propose.mock.calls.length;
    await h.visible(false);
    await nextFrames();
    expect(h.propose).toHaveBeenCalledTimes(proposals);
    expect(resizeMessages(h.socket)).toHaveLength(sizes);
    await h.visible(true);
    await nextFrames();
    expect(
      h.view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
        ?.dataset.terminalRenderer,
    ).toBe("webgl");
    expect(h.propose).toHaveBeenCalledTimes(proposals + 1);
    expect(
      resizeMessages(h.socket).every(
        (size) => size.cols === 98 && size.rows === 24,
      ),
    ).toBe(true);
    expect(testState.sockets).toHaveLength(1);
  });

  it.each(["ready", "deadline"] as const)(
    "fits only after the initial renderer decision: %s",
    async (decision) => {
      const realSetTimeout = globalThis.setTimeout;
      const timeouts = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((handler, delay, ...args) =>
          realSetTimeout(handler, delay === 150 ? 60_000 : delay, ...args),
        );
      let finishRenderer!: (value: typeof webglModule) => void;
      vi.spyOn(
        rendererModule,
        "loadOptionalTerminalWebglAddon",
      ).mockReturnValue(
        new Promise((resolve) => {
          finishRenderer = resolve;
        }),
      );
      const h = await mountContinuityViewer(false, {
        rendererGrid: true,
        native: false,
        waitForReplay: false,
        terminalId: `term_renderer_decision_${decision}`,
      });
      expect(h.propose).not.toHaveBeenCalled();
      expect(resizeMessages(h.socket)).toHaveLength(0);
      if (decision === "ready") {
        await act(async () => finishRenderer(webglModule));
      } else {
        const deadline = timeouts.mock.calls.find(
          ([, delay]) => delay === 150,
        )?.[0];
        if (typeof deadline !== "function")
          throw new Error("renderer deadline is missing");
        act(() => deadline());
      }
      await waitForReadinessCondition(
        () => expect(resizeMessages(h.socket)).toHaveLength(1),
        "initial renderer decision did not send one fit",
      );
      expect(resizeMessages(h.socket)[0].cols).toBe(
        decision === "ready" ? 98 : 92,
      );
      if (decision === "deadline") {
        await act(async () => finishRenderer(webglModule));
        await nextFrames();
        expect(resizeMessages(h.socket)).toHaveLength(1);
        expect(
          h.view.container.querySelector<HTMLElement>(
            "[data-terminal-renderer]",
          )?.dataset.terminalRenderer,
        ).toBe("dom");
      }
      expect(testState.sockets).toHaveLength(1);
    },
  );

  it("completes an initially hidden replay before draining later live output", async () => {
    const h = await mountContinuityViewer(true);
    h.socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("later-live\r\n") },
    });
    expect(h.text()).not.toContain("initial");
    await h.visible(true);
    await waitForReadinessCondition(() => {
      expect(h.text()).toContain("later-live");
      expect(
        h.view.container.querySelector<HTMLElement>("[data-terminal-renderer]")
          ?.dataset.replayHeld,
      ).toBe("false");
    }, "initially hidden replay did not reveal its live output");
    expect(h.text().match(/initial/g)).toHaveLength(1);
    expect(h.text().match(/later-live/g)).toHaveLength(1);
    expect(testState.sockets).toHaveLength(1);
  });

  it("keeps the socket and parses hidden output exactly once when shown", async () => {
    const h = await mountContinuityViewer();
    await h.visible(false);
    for (const [seq, text] of [
      [1, "hidden-one"],
      [1, "hidden-one"],
      [2, "hidden-two"],
    ] as const)
      h.socket.receive({
        type: "output",
        chunk: { seq, dataBase64: btoa(text + "\r\n") },
      });
    expect(h.text()).not.toContain("hidden-one");
    await h.visible(true);
    await waitFor(() => expect(h.text()).toContain("hidden-two"));
    expect(h.text().match(/hidden-one/g)).toHaveLength(1);
    expect(h.text().match(/hidden-two/g)).toHaveLength(1);
    await waitFor(() =>
      expect(
        h.socket.sent.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "ack", nextSeq: 3 }),
    );
    await h.visible(false);
    await h.visible(true);
    expect(testState.sockets).toHaveLength(1);
    expect(h.socket.readyState).toBe(TestTerminalSocket.OPEN);
  });

  it.each(["overflow", "gap"])(
    "replays once after hidden output %s",
    async (reason) => {
      const h = await mountContinuityViewer();
      await h.visible(false);
      if (reason === "overflow") {
        const dataBase64 = btoa("x".repeat(64 * 1024));
        for (let seq = 1; seq <= 26; seq++)
          h.socket.receive({ type: "output", chunk: { seq, dataBase64 } });
      } else {
        h.socket.receive({
          type: "output",
          chunk: { seq: 2, dataBase64: btoa("gap") },
        });
      }
      expect(testState.sockets).toHaveLength(1);
      await h.visible(true);
      await waitFor(() => expect(testState.sockets).toHaveLength(2));
      expect(
        new URL(testState.socketUrls[1]!).searchParams.get("sinceSeq"),
      ).toBe("1");
      const replaySocket = testState.sockets[1]!;
      await replaySocket.opened;
      replaySocket.receive({
        type: "attached",
        session: h.session,
        replayStartSeq: 1,
        nextSeq: 2,
      });
      replaySocket.receive({
        type: "output",
        chunk: { seq: 1, dataBase64: btoa("recovered\r\n") },
      });
      await waitFor(() => expect(h.text()).toContain("recovered"));
      await h.visible(false);
      await h.visible(true);
      expect(testState.sockets).toHaveLength(2);
      expect(h.text().match(/initial/g)).toHaveLength(1);
      expect(h.text().match(/recovered/g)).toHaveLength(1);
    },
  );
});
