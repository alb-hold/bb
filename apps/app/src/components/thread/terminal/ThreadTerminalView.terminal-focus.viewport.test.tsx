// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { waitForReadinessCondition } from "./ThreadTerminalView.terminal-focus-test-utils";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { wsManager } from "@/lib/ws";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type {} from "../../../../vitest.global-setup";
import appCss from "../../../app.css?inline";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";

const chromiumPath = inject("appChromiumPath");
const execFileAsync = promisify(execFile);

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
      experimental_screen: testState.screen,
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

function Handler() {
  useAppCommandHandler("thread.search", () => {
    testState.calls.push("search");
    return true;
  });
  return null;
}

const initialStyleSheetCount = document.styleSheets.length;

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const sheet of [...document.styleSheets]) {
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLStyleElement && !owner.isConnected) {
      owner.textContent = "";
    }
  }
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
  testState.toastError.mockReset();
  testState.touchEnabled = false;
  testState.mediaQueryListeners.clear();
  expect(document.styleSheets).toHaveLength(initialStyleSheetCount);
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

function renderMobileTerminal(
  native = false,
): ReturnType<typeof makeTerminalSession> {
  const session = makeTerminalSession({
    id: "term_mobile_paste",
    status: "running",
    cols: 40,
    rows: 12,
  });
  render(
    <MemoryRouter>
      <AppCommandProvider>
        {native ? (
          <header>
            <button aria-label="Search terminal output" />
          </header>
        ) : null}
        <ThreadTerminalView
          autoFocus={false}
          isPanelOpen
          session={session}
          attentionShownAsBanner={native}
        />
      </AppCommandProvider>
    </MemoryRouter>,
  );
  return session;
}

function scrollTerminalAsUser(terminal: Terminal, line: number): void {
  const screen = document.querySelector(".xterm-screen");
  if (!screen) throw new Error("terminal screen was not mounted");
  fireEvent.wheel(screen, { deltaY: -1 });
  terminal.scrollToLine(line);
}

describe("ThreadTerminalView terminal viewport and focus", () => {
  it("shows a jump-to-latest control only while scrolled above the bottom", async () => {
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
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created",
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
      chunk: {
        seq: 0,
        dataBase64: btoa(
          Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n"),
        ),
      },
    });
    await waitFor(() =>
      expect(getTerminal().buffer.active.baseY).toBeGreaterThan(0),
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    expect(
      screen.queryByRole("button", { name: "Jump to latest output" }),
    ).toBeNull();
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    const jump = await screen.findByRole("button", {
      name: "Jump to latest output",
    });
    socket.receive({
      type: "output",
      chunk: {
        seq: 1,
        dataBase64: btoa("\r\noutput while reviewing scrollback"),
      },
    });
    await waitFor(() =>
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "ack", nextSeq: 2 }),
    );
    expect(getTerminal().buffer.active.viewportY).toBeLessThan(
      getTerminal().buffer.active.baseY,
    );
    expect(screen.getByRole("button", { name: "Jump to latest output" })).toBe(
      jump,
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest output" }),
      ).toBeNull(),
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    fireEvent.click(
      await screen.findByRole("button", { name: "Jump to latest output" }),
    );
    expect(document.activeElement).toBe(getTerminal().textarea);
    await waitFor(() =>
      expect(getTerminal().buffer.active.viewportY).toBe(
        getTerminal().buffer.active.baseY,
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Jump to latest output" }),
    ).toBeNull();
    socket.receive({
      type: "output",
      chunk: { seq: 2, dataBase64: btoa("\r\nlatest output") },
    });
    await waitFor(() =>
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "ack", nextSeq: 3 }),
    );
    expect(
      screen.queryByRole("button", { name: "Jump to latest output" }),
    ).toBeNull();
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    await screen.findByRole("button", { name: "Jump to latest output" });
    const expandedGrid = {
      cols: getTerminal().cols,
      rows: getTerminal().buffer.active.length,
    };
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue(
      expandedGrid,
    );
    socket.receive({
      type: "session-updated",
      session: { ...session, ...expandedGrid },
    });
    await waitFor(() => expect(getTerminal().rows).toBe(expandedGrid.rows));
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    socket.receive({
      type: "output",
      chunk: { seq: 3, dataBase64: btoa(" expanded") },
    });
    await waitFor(() =>
      expect(
        testState.socketMessages.map((message) => JSON.parse(message)),
      ).toContainEqual({ type: "ack", nextSeq: 4 }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest output" }),
      ).toBeNull(),
    );
  });
  it.each(["starting", "disconnected", "exited"] as const)(
    "keeps the ready mobile controls appropriate for a %s session",
    async (status) => {
      prepareMobileTerminal();
      const session = makeTerminalSession({
        id: "term_mobile_status",
        status: "running",
      });
      const view = (current: typeof session) => (
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadTerminalView
              autoFocus={false}
              isPanelOpen
              session={current}
            />
          </AppCommandProvider>
        </MemoryRouter>
      );
      const { rerender } = render(view(session));
      await waitForReadinessCondition(
        () =>
          expect(
            screen.getByRole<HTMLButtonElement>("button", {
              name: "More terminal keys",
            }).disabled,
          ).toBe(false),
        "mobile status viewer was not ready",
      );
      rerender(view({ ...session, status }));
      const controls = screen.getByRole("group", {
        name: "Terminal keyboard controls",
      });
      expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Escape",
        }).disabled,
      ).toBe(true);
      if (status === "exited") {
        expect(controls.children).toHaveLength(4);
        for (const name of [
          "Previous prompt",
          "Next prompt",
          "Select terminal text",
        ]) {
          expect(
            screen.getByRole<HTMLButtonElement>("button", { name }).disabled,
          ).toBe(false);
        }
      } else {
        expect(controls.children).toHaveLength(1);
        for (const name of [
          "Previous prompt",
          "Next prompt",
          "Select terminal text",
        ]) {
          expect(screen.queryByRole("button", { name })).toBeNull();
        }
      }
    },
  );

  it("keeps the same collapsed row when switching to a reconnecting terminal", async () => {
    prepareMobileTerminal();
    const running = makeTerminalSession({
      id: "term_mobile_running",
      status: "running",
    });
    const reconnecting = makeTerminalSession({
      id: "term_mobile_reconnecting",
      status: "running",
    });
    const view = (
      active: string,
      status: typeof reconnecting.status = "running",
    ) => (
      <MemoryRouter>
        <AppCommandProvider>
          {[running, { ...reconnecting, status }].map((session) => (
            <div key={session.id} hidden={active !== session.id}>
              <ThreadTerminalView
                autoFocus={false}
                isPanelOpen={active === session.id}
                session={session}
              />
            </div>
          ))}
        </AppCommandProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view(reconnecting.id));
    const waitUntilReady = () =>
      waitForReadinessCondition(
        () =>
          expect(
            screen.getByRole<HTMLButtonElement>("button", {
              name: "More terminal keys",
            }).disabled,
          ).toBe(false),
        "switched mobile viewer was not ready",
      );
    await waitUntilReady();
    rerender(view(running.id));
    await waitUntilReady();
    const runningControls = screen.getByRole("group", {
      name: "Terminal keyboard controls",
    });
    expect(runningControls.children).toHaveLength(1);
    const collapsedClass = runningControls.className;
    for (const active of [reconnecting.id, running.id, reconnecting.id]) {
      rerender(view(active, "disconnected"));
      const controls = screen.getByRole("group", {
        name: "Terminal keyboard controls",
      });
      expect(controls.className).toBe(collapsedClass);
      expect(controls.children).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Select terminal text" }),
      ).toBeNull();
    }
  });

  it.each([true, false])(
    "leaves one header search action in a native pane with touch=%s",
    async (touch) => {
      prepareMobileTerminal();
      testState.touchEnabled = touch;
      const loadAddon = vi.spyOn(Terminal.prototype, "loadAddon");
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
        cols: 40,
        rows: 12,
      });
      renderMobileTerminal(true);
      await waitForReadinessCondition(
        () =>
          expect(
            loadAddon.mock.calls.some(([addon]) => "findNext" in addon),
          ).toBe(true),
        "terminal search addon was not loaded within 5000 ms",
      );
      expect(
        screen.getAllByRole("button", { name: "Search terminal output" }),
      ).toHaveLength(1);
      if (touch) {
        expect(
          screen
            .getByRole("group", { name: "Terminal keyboard controls" })
            .classList.contains("py-0"),
        ).toBe(true);
        expect(
          screen
            .getByRole("button", { name: "Escape" })
            .classList.contains("h-11"),
        ).toBe(true);
      }
    },
  );
  it.each([360, 390, 767, 768, 1440])(
    "starts terminals with responsive typography at %s px",
    async (width) => {
      prepareMobileTerminal();
      vi.stubGlobal("innerWidth", width);
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches:
          query === "(pointer: coarse)" ||
          (query === "(max-width: 767px)" && width <= 767),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      }));
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
        cols: 40,
        rows: 12,
      });
      renderMobileTerminal();
      await waitFor(() =>
        expect(
          document
            .querySelector("[data-terminal-font-size]")
            ?.getAttribute("data-terminal-font-size"),
        ).toBe(width < 768 ? "15" : "14"),
      );
    },
  );
  it("uses the shared renderer cell line spacing when mounting the DOM terminal", async () => {
    prepareMobileTerminal();
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
      cols: 40,
      rows: 12,
    });
    let terminal: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(
      function (this: Terminal, element) {
        terminal = this;
        open.call(this, element);
      },
    );
    renderMobileTerminal();
    await waitFor(() => expect(terminal?.options.lineHeight).toBe(1.22));
    await waitFor(() => {
      expect(terminal?.options.cursorInactiveStyle).toBe("outline");
      expect(terminal?.options.cursorStyle).toBe("block");
    });
  });
  it("keeps a bottom-following client at the bottom after output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    const baseYBeforeOutput = getTerminal().buffer.active.baseY;
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 1_000)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.baseY).toBeGreaterThan(
          baseYBeforeOutput + 100,
        ),
      "terminal output was not parsed within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(lines(1_001, 1_100)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    fitCols = 38;
    fitRows = 5;
    await act(async () => {
      socket.receive({
        type: "session-updated",
        session: { ...session, cols: 38, rows: 5 },
      });
      await Promise.resolve();
    });
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "bottom-following client did not remain at the bottom after companion resize",
    );
  });

  it("keeps a saved bottom-follow position after live output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 300)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    expect(
      getTerminal().buffer.active.viewportY,
      "terminal scrollLines did not move above the bottom",
    ).toBeLessThan(getTerminal().buffer.active.baseY);
    getTerminal().scrollToBottom();
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(
      JSON.parse(
        sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste") ??
          "null",
      ),
    ).toMatchObject({ distanceFromTail: 0, outputSequence: 0 });
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(lines(301, 500)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    expect(getTerminal().buffer.active.viewportY).toBe(
      getTerminal().buffer.active.baseY,
    );
    fitCols = 38;
    fitRows = 5;
    socket.receive({
      type: "session-updated",
      session: { ...session, cols: 38, rows: 5 },
    });
    act(() => getTerminal().resize(38, 5));
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "bottom-following client did not remain at the bottom after companion resize",
    );
  });

  it("keeps a live scrolled-up line through a shared resize without stored viewport state", async () => {
    prepareMobileTerminal();
    const openTerminal = Terminal.prototype.open;
    let mountedTerminal: Terminal | null = null;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    expect(
      sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste"),
    ).toBeNull();
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 300 },
      (_, index) => `line ${String(index + 1).padStart(5, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    const terminal = getTerminal();
    terminal.scrollToLine(terminal.buffer.active.baseY - 1);
    expect(
      terminal.buffer.active.viewportY,
      "terminal did not scroll above the bottom before shared resize",
    ).toBeLessThan(terminal.buffer.active.baseY);
    const topLine = terminal.buffer.active
      .getLine(terminal.buffer.active.viewportY)
      ?.translateToString(true);
    expect(topLine).toMatch(/^line \d{5}$/);
    expect(
      sessionStorage.getItem("bb:terminal-viewport:term_mobile_paste"),
    ).toBeNull();
    socket.receive({
      type: "session-updated",
      session: { ...session, cols: 38, rows: 5 },
    });
    await waitForReadinessCondition(() => {
      expect(terminal.cols).toBe(38);
      expect(terminal.rows).toBe(5);
    }, "shared PTY grid resize was not applied within 5000 ms");
    await waitForReadinessCondition(() => {
      expect(terminal.buffer.active.viewportY).toBeLessThan(
        terminal.buffer.active.baseY,
      );
      expect(
        terminal.buffer.active
          .getLine(terminal.buffer.active.viewportY)
          ?.translateToString(true),
      ).toBe(topLine);
    }, "shared resize moved the live scrolled-up line");
  });

  it("restores a reloaded bottom-following client after a terminal resize", async () => {
    prepareMobileTerminal();
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: 40, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    sessionStorage.setItem(
      "bb:terminal-viewport:term_mobile_paste",
      JSON.stringify({
        distanceFromTail: 0,
        lineOffset: 100,
        outputSequence: 0,
      }),
    );
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 500 },
      (_, index) => `line ${String(index + 1).padStart(5, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "bottom-follow replay was not acknowledged within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "reloaded bottom-following client was not at the bottom after replay",
    );
    fitRows = 11;
    act(() => getTerminal().resize(40, fitRows));
    await waitForReadinessCondition(
      () => expect(getTerminal().rows).toBe(11),
      "settled terminal grid resize was not applied within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "reloaded bottom-following client did not settle at the bottom",
    );
  });

  it("keeps a live bottom-following client at the bottom after typed output and a shared resize", async () => {
    prepareMobileTerminal();
    let fitCols = 40;
    let fitRows = 12;
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      () => ({ cols: fitCols, rows: fitRows }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let mountedTerminal: Terminal | null = null;
    const openTerminal = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      mountedTerminal ??= this;
      openTerminal.call(this, element);
    });
    const getTerminal = () => {
      if (!mountedTerminal) throw new Error("terminal was not mounted");
      return mountedTerminal;
    };
    const session = renderMobileTerminal();
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const lines = (start: number, end: number) =>
      Array.from(
        { length: end - start + 1 },
        (_, index) => `line ${String(start + index).padStart(5, "0")}`,
      ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(lines(1, 1_000)) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "replay output was not acknowledged within 5000 ms",
    );
    scrollTerminalAsUser(getTerminal(), getTerminal().buffer.active.baseY - 1);
    expect(
      getTerminal().buffer.active.viewportY,
      "terminal scrollLines did not move above the bottom before typed output",
    ).toBeLessThan(getTerminal().buffer.active.baseY);
    await new Promise((resolve) => setTimeout(resolve, 275));
    getTerminal().input("echo case-c\r", true);
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa(`${lines(1_001, 1_100)}\r\n`) },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "live output was not acknowledged within 5000 ms",
    );
    getTerminal().scrollToBottom();
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "typed live output did not move the terminal to the bottom",
    );
    fitCols = 38;
    fitRows = 5;
    socket.receive({
      type: "output",
      chunk: {
        seq: 2,
        dataBase64: btoa(
          `\u001b]7791;bb-grid;38;5\u0007${lines(1_101, 1_120)}\r\n`,
        ),
      },
    });
    await waitForReadinessCondition(() => {
      expect(getTerminal().cols).toBe(38);
      expect(getTerminal().rows).toBe(5);
    }, "in-band shared PTY grid marker was not applied within 5000 ms");
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 3 }),
      "in-band resize output was not acknowledged within 5000 ms",
    );
    await waitForReadinessCondition(
      () =>
        expect(getTerminal().buffer.active.viewportY).toBe(
          getTerminal().buffer.active.baseY,
        ),
      "typed-output client left the bottom after companion resize",
    );
  });

  it.each(["legacy", "batch"])(
    "keeps a saved anchor through %s replay and column reflow",
    async (mode) => {
      prepareMobileTerminal();
      let fitCols = 40;
      vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
        () => ({ cols: fitCols, rows: 12 }),
      );
      vi.stubGlobal(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => {
          queueMicrotask(() => callback(0));
          return 1;
        },
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let mountedTerminal: Terminal | null = null;
      const openTerminal = Terminal.prototype.open;
      vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
        this: Terminal,
        element: HTMLElement,
      ) {
        mountedTerminal ??= this;
        openTerminal.call(this, element);
      });
      const getTerminal = () => {
        if (!mountedTerminal) throw new Error("terminal was not mounted");
        return mountedTerminal;
      };
      sessionStorage.setItem(
        "bb:terminal-viewport:term_mobile_paste",
        JSON.stringify({
          distanceFromTail: 388,
          lineOffset: 100,
          outputSequence: mode === "batch" ? 1 : 0,
        }),
      );
      const session = renderMobileTerminal();
      await waitForReadinessCondition(
        () => expect(testState.sockets).toHaveLength(1),
        "terminal socket was not created within 5000 ms",
      );
      const socket = testState.sockets[0];
      if (!socket) throw new Error("terminal socket was not created");
      if (mode === "batch")
        Object.defineProperty(socket, "protocol", {
          value: "bb.terminal.replay-batch.v1",
        });
      socket.receive({
        type: "attached",
        session,
        replayStartSeq: 0,
        nextSeq: mode === "batch" ? 3 : 1,
      });
      const output = Array.from({ length: 500 }, (_, index) => {
        const number = String(index + 1).padStart(5, "0");
        return `line ${number} ${"0123456789".repeat(2)}01234567`;
      }).join("\r\n");
      socket.receive(
        mode === "batch"
          ? {
              type: "output-batch",
              chunks: [
                { seq: 0, dataBase64: btoa("before anchor\r\n") },
                { seq: 1, dataBase64: btoa(output) },
                { seq: 2, dataBase64: btoa("\r\nafter anchor") },
              ],
            }
          : {
              type: "output",
              chunk: { seq: 0, dataBase64: btoa(output) },
            },
      );
      await waitForReadinessCondition(
        () => expect(getTerminal().buffer.active.baseY).toBeGreaterThan(0),
        "terminal output was not parsed within 5000 ms",
      );
      await waitForReadinessCondition(
        () =>
          expect(
            testState.socketMessages.map((message) => JSON.parse(message)),
          ).toContainEqual({ type: "ack", nextSeq: mode === "batch" ? 3 : 1 }),
        "saved viewport replay was not acknowledged within 5000 ms",
      );
      const lineBefore = getTerminal()
        .buffer.active.getLine(getTerminal().buffer.active.viewportY)
        ?.translateToString(true);
      expect(lineBefore).toMatch(/^line \d{5} /);
      expect(lineBefore?.length).toBeGreaterThan(20);
      expect(getTerminal().buffer.active.viewportY).toBeLessThan(
        getTerminal().buffer.active.baseY,
      );
      fitCols = 20;
      act(() => getTerminal().resize(20, 12));
      await waitForReadinessCondition(
        () => expect(getTerminal().cols).toBe(20),
        "component column reflow was not applied within 5000 ms",
      );

      await waitForReadinessCondition(
        () =>
          expect(
            getTerminal()
              .buffer.active.getLine(getTerminal().buffer.active.viewportY)
              ?.translateToString(true)
              ?.match(/^line (\d{5}) /)?.[1],
          ).toBe(lineBefore?.match(/^line (\d{5}) /)?.[1]),
        "component did not restore the scrolled line after shared column reflow",
      );
    },
  );

  it("uses gesture-start scale for uneven multi-frame pinch gestures", async () => {
    vi.stubGlobal("innerWidth", 390);
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
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
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
        const fontSize = Number(
          document
            .querySelector("[data-terminal-renderer]")
            ?.getAttribute("data-terminal-font-size") ?? 13,
        );
        return {
          cols: Math.round(612 / fontSize),
          rows: Math.round(676.8 / (fontSize * 1.2)),
        };
      },
    );

    render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_multiframe_pinch",
              status: "running",
              cols: 51,
              rows: 47,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(testState.sockets).toHaveLength(1));
    const pane = document.querySelector(".group\\/terminal-pane");
    const fontSizeNode = document.querySelector("[data-terminal-renderer]");
    expect(pane).not.toBeNull();
    expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("15");

    const dispatchTouches = (
      type: "touchstart" | "touchmove" | "touchend",
      distance: number,
      ending = false,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const points = [
        { identifier: 1, clientX: 100 - distance / 2, clientY: 100 },
        { identifier: 2, clientX: 100 + distance / 2, clientY: 100 },
      ];
      const touchList = (items: typeof points) =>
        Object.assign(items, { item: (index: number) => items[index] ?? null });
      Object.defineProperty(event, "touches", {
        value: touchList(ending ? [] : points),
      });
      Object.defineProperty(event, "targetTouches", {
        value: touchList(ending ? [] : points),
      });
      Object.defineProperty(event, "changedTouches", {
        value: touchList(points),
      });
      fireEvent(pane as HTMLElement, event);
    };
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
        .filter((message) => message.type === "resize")
        .map(({ type, cols, rows }) => ({ type, cols, rows }));

    await waitForReadinessCondition(
      () => expect(resizeMessages()).toHaveLength(1),
      "initial pinch grid was not resized",
    );
    const originalGrid = resizeMessages().at(-1);
    dispatchTouches("touchstart", 100);
    for (const ratio of [
      1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5,
    ]) {
      dispatchTouches("touchmove", 100 * ratio);
    }
    dispatchTouches("touchend", 150, true);
    await waitFor(() =>
      expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("23"),
    );
    await waitFor(() => expect(resizeMessages()).toHaveLength(2));
    expect(resizeMessages().at(-1)).toEqual({
      type: "resize",
      cols: 27,
      rows: 25,
    });

    dispatchTouches("touchstart", 150);
    for (const ratio of [1.45, 1.4, 1.35, 1.3, 1.25, 1.2, 1.15, 1.1, 1.05, 1]) {
      dispatchTouches("touchmove", 150 * (ratio / 1.5));
    }
    dispatchTouches("touchend", 100, true);
    await waitFor(() =>
      expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("15"),
    );
    await waitFor(() => expect(resizeMessages()).toHaveLength(3));
    expect(resizeMessages().at(-1)).toEqual(originalGrid);
    dispatchTouches("touchstart", 100);
    dispatchTouches("touchmove", 50);
    dispatchTouches("touchend", 50, true);
    expect(fontSizeNode?.getAttribute("data-terminal-font-size")).toBe("12");
  });

  it("preserves the open terminal and its scrollback when pointer mode changes", async () => {
    prepareMobileTerminal();
    testState.touchEnabled = false;
    const session = renderMobileTerminal();

    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not created within 5000 ms",
    );
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 1,
    });
    const output = Array.from(
      { length: 48 },
      (_, index) => `retained-${String(index + 1).padStart(2, "0")}`,
    ).join("\r\n");
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa(output) },
    });
    await waitForReadinessCondition(() => {
      expect(document.querySelector(".xterm-rows")?.textContent).toContain(
        "retained-48",
      );
    }, "retained-48 rendered BEFORE pointer toggle");
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 1 }),
      "retained-48 replay was not acknowledged BEFORE pointer toggle",
    );
    const xterm = document.querySelector(".xterm");
    expect(xterm).not.toBeNull();

    act(() => {
      testState.touchEnabled = true;
      for (const notify of [...testState.mediaQueryListeners]) notify();
    });

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(
      () => expect(testState.sockets).toHaveLength(1),
      "terminal socket was not retained after pointer mode changed within 5000 ms",
    );
    expect(document.querySelector(".xterm")).toBe(xterm);
    socket.receive({
      type: "output",
      chunk: { seq: 1, dataBase64: btoa("after-toggle-output") },
    });
    await waitForReadinessCondition(
      () =>
        expect(
          testState.socketMessages.map((message) => JSON.parse(message)),
        ).toContainEqual({ type: "ack", nextSeq: 2 }),
      "new output was not acknowledged AFTER pointer toggle",
    );
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select terminal text" }),
    );
    await waitForReadinessCondition(() => {
      const snapshot = screen.getByRole("textbox", {
        name: "Terminal text snapshot",
      }) as HTMLTextAreaElement;
      expect(snapshot.value).toContain("retained-01");
      expect(snapshot.value).toContain("retained-48");
      expect(snapshot.value).toContain("after-toggle-output");
    }, "scrollback survives pointer toggle: retained and new output must render");
  }, 30_000);

  it("sends clipboard text once through xterm paste input", async () => {
    prepareMobileTerminal();
    const readText = vi.fn().mockResolvedValue("paste-once");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const session = renderMobileTerminal();

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    }, "mobile terminal controls did not become enabled within 5000 ms");
    const socket = testState.sockets[0];
    if (!socket) throw new Error("terminal socket was not created");
    socket.receive({
      type: "attached",
      session,
      replayStartSeq: 0,
      nextSeq: 0,
    });
    socket.receive({
      type: "output",
      chunk: { seq: 0, dataBase64: btoa("\x1b[?2004h") },
    });
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitForReadinessCondition(() => {
      const inputMessages = testState.socketMessages
        .map(
          (message) =>
            JSON.parse(message) as { dataBase64?: string; type?: string },
        )
        .filter(
          (message): message is { dataBase64: string; type: "input" } =>
            message.type === "input" && typeof message.dataBase64 === "string",
        );
      expect(inputMessages).toHaveLength(1);
      expect(
        new TextDecoder().decode(
          decodeBase64Bytes(inputMessages[0]!.dataBase64),
        ),
      ).toBe("paste-once");
    }, "clipboard text was not sent through terminal input within 5000 ms");
    expect(readText).toHaveBeenCalledOnce();
    expect(testState.toastError).not.toHaveBeenCalled();
  });

  it("shows the clipboard fallback without sending input when read is denied", async () => {
    prepareMobileTerminal();
    const readText = vi.fn().mockRejectedValue(new DOMException("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    renderMobileTerminal();

    await waitForReadinessCondition(
      () => screen.getByRole("button", { name: "More terminal keys" }),
      "mobile terminal controls were not rendered within 5000 ms",
    );
    await waitForReadinessCondition(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "More terminal keys",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    }, "mobile terminal controls did not become enabled within 5000 ms");
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitForReadinessCondition(() => {
      expect(testState.toastError).toHaveBeenCalledWith(
        "This connection can’t read the clipboard. Long-press a message box and choose Paste.",
      );
    }, "clipboard denial fallback was not shown within 5000 ms");
    expect(readText).toHaveBeenCalledOnce();
    expect(
      testState.socketMessages
        .map((message) => JSON.parse(message) as { type?: string })
        .filter((message) => message.type === "input"),
    ).toHaveLength(0);
  });

  it("suppresses terminal-scoped shortcuts from the real xterm input", async () => {
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
          <Handler />
          <button type="button" aria-label="Outside terminal" />
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            session={makeTerminalSession({
              id: "term_focus",
              threadId: "thr_focus",
              environmentId: "env_focus",
              hostId: "host_focus",
              createdAt: 1,
              updatedAt: 1,
              status: "running",
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    const terminalInput = await waitForReadinessCondition(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (textarea === null) throw new Error("xterm input is not mounted");
      return textarea;
    }, "xterm input was not mounted within 5000 ms");
    const outside = screen.getByLabelText("Outside terminal");
    const dispatchSearch = (target: Element) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "k",
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(dispatchSearch(outside).defaultPrevented).toBe(true);
    expect(testState.calls).toEqual(["search"]);
    testState.calls.length = 0;
    terminalInput.focus();
    expect(document.activeElement).toBe(terminalInput);

    const event = dispatchSearch(terminalInput);

    expect(event.defaultPrevented).toBe(false);
    expect(testState.calls).toEqual([]);
  });
});

describe.skipIf(chromiumPath === null && !process.env.CI)(
  "jump-to-latest geometry in real Chromium",
  () => {
    it.each([360, 390, 1280])(
      "keeps the control clear of the last row and composer at %i px",
      async (width) => {
        expect(chromiumPath).not.toBeNull();
        prepareMobileTerminal();
        for (const metric of ["offsetWidth", "clientWidth"] as const) {
          vi.spyOn(HTMLElement.prototype, metric, "get").mockImplementation(
            function (this: HTMLElement) {
              return this.classList.contains("xterm-char-measure-element")
                ? Math.max(1, this.textContent?.length ?? 1) * 9
                : width - 24;
            },
          );
        }
        testState.touchEnabled = width < 768;
        let terminal: Terminal | null = null;
        const open = Terminal.prototype.open;
        vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
          this: Terminal,
          element: HTMLElement,
        ) {
          terminal ??= this;
          open.call(this, element);
        });
        const session = makeTerminalSession({
          id: `term_jump_layout_${width}`,
          status: "running",
          cols: Math.floor((width - 24) / 9),
          rows: 12,
        });
        vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
          cols: session.cols,
          rows: session.rows,
        });
        render(
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
        await waitFor(() => expect(testState.sockets).toHaveLength(1));
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
          chunk: {
            seq: 0,
            dataBase64: btoa(
              Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n"),
            ),
          },
        });
        const currentTerminal = () => {
          if (!terminal) throw new Error("terminal was not mounted");
          return terminal;
        };
        await waitFor(() =>
          expect(currentTerminal().buffer.active.baseY).toBeGreaterThan(0),
        );
        scrollTerminalAsUser(
          currentTerminal(),
          currentTerminal().buffer.active.baseY - 1,
        );
        await screen.findByRole("button", { name: "Jump to latest output" });
        await waitFor(() =>
          expect(
            currentTerminal().element?.querySelector(
              ".xterm-rows > div:last-child",
            )?.textContent,
          ).toContain("line"),
        );
        currentTerminal().element?.setAttribute(
          "data-layout-live-terminal",
          "",
        );
        const root = document.querySelector("[data-app-terminal]");
        if (!root) throw new Error("terminal view was not mounted");
        const rendererCss = [...document.querySelectorAll("style")]
          .map((style) => style.textContent)
          .join("\n");
        const css = `${appCss}\n${xtermCss}\n${rendererCss}`.replace(
          /url\((["']?)(\/[^)"']+)\1\)/g,
          (_match, _quote: string, asset: string) =>
            `url("${pathToFileURL(asset.startsWith("/@fs/") ? asset.slice(4) : resolve(process.cwd(), `.${asset}`))}")`,
        );
        const dir = await mkdtemp(join(tmpdir(), "bb-jump-layout-"));
        try {
          const file = join(dir, "index.html");
          const frame =
            `<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style>${root.outerHTML}<textarea aria-label="Message composer" class="block h-12 w-full"></textarea>`
              .replaceAll("&", "&amp;")
              .replaceAll('"', "&quot;")
              .replaceAll("<", "&lt;");
          await writeFile(
            file,
            `<!doctype html><style>body{margin:0}iframe{display:block;border:0;width:${width}px;height:600px}</style><iframe srcdoc="${frame}"></iframe><pre id="result"></pre><script>
const frame=document.querySelector('iframe');
frame.addEventListener('load',async()=>{
  const doc=frame.contentDocument, win=frame.contentWindow;
  await doc.fonts.ready;
  const root=doc.querySelector('[data-app-terminal]');
  const pane=doc.querySelector('[data-terminal-renderer]').parentElement;
  const controls=doc.querySelector('[data-terminal-mobile-controls]');
  const screen=doc.querySelector('[data-layout-live-terminal] .xterm-screen');
  root.style.height=(screen.getBoundingClientRect().height+parseFloat(win.getComputedStyle(pane).paddingTop)+parseFloat(win.getComputedStyle(pane).paddingBottom)+[...root.children].filter(el=>el!==pane&&!['absolute','fixed'].includes(win.getComputedStyle(el).position)).reduce((sum,el)=>sum+el.getBoundingClientRect().height,0))+'px';
  const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
  const button=doc.querySelector('[aria-label="Jump to latest output"]');
  const rows=[...doc.querySelectorAll('[data-layout-live-terminal] .xterm-rows > div')];
  const screenBox=screen.getBoundingClientRect();
  const last=rows.filter(el=>{const r=el.getBoundingClientRect();return r.y<screenBox.bottom&&r.bottom>screenBox.y}).at(-1);
  const range=doc.createRange();range.selectNodeContents(last);
  const text=range.getBoundingClientRect();
  const lastBox=last.getBoundingClientRect();
  const lastRow={x:lastBox.x,y:Math.max(lastBox.y,screenBox.y),width:lastBox.width,height:Math.min(lastBox.bottom,screenBox.bottom)-Math.max(lastBox.y,screenBox.y)};
  const cell=screenBox.width/${currentTerminal().cols};
  document.querySelector('#result').textContent=JSON.stringify({coarse:win.matchMedia('(pointer: coarse)').matches,viewportWidth:win.innerWidth,viewportHeight:win.innerHeight,button:box(button),pane:box(pane),lastRow,lastColumn:{x:screenBox.right-cell,y:screenBox.y,width:cell,height:screenBox.height},composer:box(doc.querySelector('textarea[aria-label="Message composer"]')),controls:controls?box(controls):null,fontSizes:[...new Set([button,...button.querySelectorAll('*')].map(el=>win.getComputedStyle(el).fontSize))],rowTextWidth:text.width});
});
</script>`,
          );
          const { stdout } = await execFileAsync(
            chromiumPath!,
            [
              "--headless",
              `--user-data-dir=${join(dir, "profile")}`,
              "--no-sandbox",
              "--disable-gpu",
              "--disable-dev-shm-usage",
              "--disable-extensions",
              "--disable-background-networking",
              "--no-first-run",
              ...(width < 768
                ? [
                    "--blink-settings=primaryPointerType=2,availablePointerTypes=2",
                  ]
                : []),
              "--virtual-time-budget=5000",
              "--dump-dom",
              pathToFileURL(file).href,
            ],
            { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          );
          const raw = /<pre id="result">([^<]+)<\/pre>/.exec(stdout)?.[1];
          expect(raw).toBeDefined();
          const box = z.object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          });
          const result = z
            .object({
              coarse: z.boolean(),
              viewportWidth: z.number(),
              viewportHeight: z.number(),
              button: box,
              pane: box,
              lastRow: box,
              lastColumn: box,
              composer: box,
              controls: box.nullable(),
              fontSizes: z.array(z.string()),
              rowTextWidth: z.number(),
            })
            .parse(
              JSON.parse(
                raw!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
              ),
            );
          console.log("C21_LAYOUT " + JSON.stringify({ width, ...result }));
          const overlaps = (a: z.infer<typeof box>, b: z.infer<typeof box>) =>
            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y;
          expect(result.viewportWidth).toBe(width);
          expect(result.coarse).toBe(width < 768);
          expect(result.lastRow.height).toBeGreaterThan(0);
          expect(result.rowTextWidth).toBeGreaterThan(0);
          expect(result.lastColumn.width).toBeGreaterThan(5);
          expect(result.lastRow.y + result.lastRow.height).toBeLessThanOrEqual(
            result.pane.y + result.pane.height + 1,
          );
          expect(result.fontSizes).toHaveLength(1);
          expect(result.button.width).toBeGreaterThanOrEqual(
            width < 768 ? 44 : 32,
          );
          expect(result.button.height).toBeGreaterThanOrEqual(
            width < 768 ? 44 : 32,
          );
          expect(result.button.x).toBeGreaterThanOrEqual(0);
          expect(result.button.y).toBeGreaterThanOrEqual(result.pane.y);
          expect(result.button.x + result.button.width).toBeLessThanOrEqual(
            result.viewportWidth,
          );
          expect(result.button.y + result.button.height).toBeLessThanOrEqual(
            result.pane.y + result.pane.height,
          );
          expect(result.button.y + result.button.height).toBeLessThanOrEqual(
            result.viewportHeight,
          );
          expect(overlaps(result.button, result.lastRow)).toBe(false);
          expect(overlaps(result.button, result.lastColumn)).toBe(false);
          expect(overlaps(result.button, result.composer)).toBe(false);
          if (result.controls)
            expect(overlaps(result.button, result.controls)).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      40_000,
    );
  },
);
