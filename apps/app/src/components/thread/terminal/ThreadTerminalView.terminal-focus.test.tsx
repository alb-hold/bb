// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { TerminalBrowserSocket } from "@bb/client-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  clearAttention: vi.fn(),
  createSocket: vi.fn(),
}));

vi.mock("@bb/client-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/client-core")>();
  class TestTerminalWebSocketTransport
    extends actual.TerminalWebSocketTransport
  {
    constructor(
      options: ConstructorParameters<
        typeof actual.TerminalWebSocketTransport
      >[0],
    ) {
      super({
        ...options,
        createSocket: (url) => testState.createSocket(url),
      });
    }
  }
  return {
    ...actual,
    TerminalWebSocketTransport: TestTerminalWebSocketTransport,
  };
});

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
  vi.restoreAllMocks();
  testState.calls.length = 0;
  testState.clearAttention.mockReset();
  testState.createSocket.mockReset();
});

beforeEach(() => {
  testState.createSocket.mockImplementation(() => new TerminalSocket());
});

class TerminalSocket implements TerminalBrowserSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 0;
  owner = false;
  size = { cols: 55, rows: 41 };
  sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  send(payload: string): void {
    const message = JSON.parse(payload) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type !== "resize") return;
    if (message.claim === true) this.owner = true;
    const cols = Number(message.cols);
    const rows = Number(message.rows);
    if (this.owner && (cols !== this.size.cols || rows !== this.size.rows)) {
      this.size = { cols, rows };
      queueMicrotask(() =>
        this.receive({
          type: "session-updated",
          session: makeTerminalSession({ cols, rows }),
        }),
      );
    }
    if (typeof message.seq === "number") {
      queueMicrotask(() =>
        this.receive({ type: "resize-applied", seq: message.seq }),
      );
    }
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" } as CloseEvent);
  }
}

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
