// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AppCommandProvider,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { ThreadTerminalView } from "./ThreadTerminalView";

const state = vi.hoisted(() => ({
  input: vi.fn(),
  acknowledged: vi.fn(),
  onMessage: null as ((message: unknown) => void) | null,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { generalSettings: { terminalCopyOnSelect: true } },
  }),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: vi.fn(async () => true),
}));

vi.mock("@/hooks/usePluginCommandBindings", () => {
  const binding = (
    command: string,
    key: string,
    modifiers: { shift?: boolean },
    when: { all: string[]; none: string[] },
  ) => ({
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: modifiers.shift ?? false,
    },
    when,
  });
  const main = { all: ["mainSurface"], none: ["modalOpen"] };
  const defaults = [
    binding("thread.search", "k", {}, main),
    binding("panel.close", "w", {}, main),
    binding(
      "terminal.find",
      "f",
      {},
      {
        all: ["mainSurface", "terminalFocus", "macPlatform"],
        none: ["modalOpen"],
      },
    ),
    binding(
      "terminal.find",
      "f",
      { shift: true },
      {
        all: ["mainSurface", "terminalFocus"],
        none: ["modalOpen", "macPlatform"],
      },
    ),
  ];
  return {
    usePluginCommandBindings: () => ({ keybindings: defaults, defaults }),
  };
});

vi.mock("@xterm/addon-webgl", () => {
  throw new Error("WebGL unavailable");
});

vi.mock("@bb/client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bb/client-core")>()),
  TerminalWebSocketTransport: class {
    constructor(options: { onMessage: (message: unknown) => void }) {
      state.onMessage = options.onMessage;
    }
    sendInput = state.input;
    sendResize() {}
    setVisible() {}
    start() {}
    dispose() {}
    acknowledgeOutput = state.acknowledged;
  },
}));

const appCommands = vi.hoisted(() => ({
  threadSearch: vi.fn(() => true),
  panelClose: vi.fn(() => true),
}));

function AppCommandSpies() {
  useAppCommandHandler("thread.search", appCommands.threadSearch);
  useAppCommandHandler("panel.close", appCommands.panelClose);
  return null;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "measureText") {
            return (text: string) => ({ width: text.length * 9 });
          }
          if (property === "getImageData") {
            return () => ({ data: [212, 167, 44, 255] });
          }
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(copyToClipboardWithToast).mockClear();
  appCommands.threadSearch.mockClear();
  appCommands.panelClose.mockClear();
  state.input.mockClear();
  state.acknowledged.mockClear();
  state.onMessage = null;
});

async function writeOutput(seq: number, text: string) {
  await act(async () => {
    state.onMessage?.({
      type: "output",
      chunk: { seq, dataBase64: btoa(text) },
    });
  });
  await waitFor(() =>
    expect(state.acknowledged).toHaveBeenLastCalledWith(seq + 1),
  );
}

async function mount() {
  const view = render(
    <AppCommandProvider>
      <AppCommandSpies />
      <ThreadTerminalView
        autoFocus
        isPanelOpen
        session={makeTerminalSession({ status: "running" })}
      />
    </AppCommandProvider>,
  );
  const textarea = await waitFor(() => {
    const element = view.container.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(element).not.toBeNull();
    return element!;
  });
  await waitFor(() => expect(state.onMessage).not.toBeNull());
  await writeOutput(0, "needle first\r\nother\r\nneedle last\r\n");
  await writeOutput(1, "filler\r\n".repeat(60));
  textarea.focus();
  return { textarea };
}

it("finds scrollback without copying matches, navigates them, and returns focus on Escape", async () => {
  const { textarea } = await mount();
  fireEvent.keyDown(textarea, { key: "f", metaKey: true, keyCode: 70 });
  const input = await screen.findByRole("searchbox", {
    name: "Find in terminal",
  });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "needle" } });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("1 / 2"),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("2 / 2"),
  );
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("1 / 2"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Match case" }));
  fireEvent.change(input, { target: { value: "NEEDLE" } });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("0 / 0"),
  );
  expect(copyToClipboardWithToast).not.toHaveBeenCalled();
  expect(state.input).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(document.activeElement).toBe(textarea);
});

it("leaves Ctrl+letter shell keys to the shell on Linux and finds with Ctrl+Shift+F", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const { textarea } = await mount();
  fireEvent.keyDown(textarea, { key: "k", ctrlKey: true, keyCode: 75 });
  fireEvent.keyDown(textarea, { key: "w", ctrlKey: true, keyCode: 87 });
  fireEvent.keyDown(textarea, { key: "f", ctrlKey: true, keyCode: 70 });
  expect(state.input.mock.calls.map(([data]) => atob(data))).toEqual([
    "\x0b",
    "\x17",
    "\x06",
  ]);
  expect(appCommands.threadSearch).not.toHaveBeenCalled();
  expect(appCommands.panelClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("search")).toBeNull();
  fireEvent.keyDown(textarea, {
    key: "F",
    ctrlKey: true,
    shiftKey: true,
    keyCode: 70,
  });
  expect(
    await screen.findByRole("searchbox", { name: "Find in terminal" }),
  ).toBe(document.activeElement);
  expect(state.input).toHaveBeenCalledTimes(3);
});
