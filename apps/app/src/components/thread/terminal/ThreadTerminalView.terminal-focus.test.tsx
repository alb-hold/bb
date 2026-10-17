// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
  socketMessages: [] as string[],
}));

class TestTerminalSocket {
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  bufferedAmount = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = TestTerminalSocket.CONNECTING;

  constructor() {
    queueMicrotask(() => {
      this.readyState = TestTerminalSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  close(): void {
    this.readyState = TestTerminalSocket.CLOSED;
  }

  send(data: string): void {
    testState.socketMessages.push(data);
  }
}

vi.mock("@/lib/sdk", () => ({
  sdk: {
    terminals: {
      experimental_attention: {
        clear: testState.clearAttention,
      },
    },
  },
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  testState.calls.length = 0;
  testState.socketMessages.length = 0;
  testState.clearAttention.mockReset();
});

describe("ThreadTerminalView terminal focus boundary", () => {
  it("clears attention when its terminal panel becomes visible", async () => {
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

    await waitFor(() => {
      expect(testState.clearAttention).toHaveBeenCalledWith({
        terminalId: session.id,
      });
      expect(onSessionChange).toHaveBeenCalledWith(updatedSession);
    });
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
    const unavailableMeasurements: ReturnType<FitAddon["proposeDimensions"]>[] =
      Array.from({ length: 16 }, () => undefined);
    vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(
      function proposeDimensions(this: FitAddon) {
        return unavailableMeasurements.length > 0
          ? unavailableMeasurements.shift()
          : originalProposeDimensions.call(this);
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

    await waitFor(() => {
      const resize = testState.socketMessages
        .map(
          (message) => JSON.parse(message) as { cols?: number; type?: string },
        )
        .find((message) => message.type === "resize");
      expect(resize).toBeDefined();
      expect(resize?.cols).toBeLessThan(120);
    });
  });

  it("suppresses terminal-scoped shortcuts from the real xterm input", async () => {
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

    const terminalInput = await waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (textarea === null) throw new Error("xterm input is not mounted");
      return textarea;
    });
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
