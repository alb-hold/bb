// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { ThreadTerminalView } from "./ThreadTerminalView";

const testState = vi.hoisted(() => ({
  clearAttention: vi.fn(),
  output: vi.fn(),
  screen: vi.fn(),
  toastError: vi.fn(),
  touchEnabled: false,
}));

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
  const actual =
    await importOriginal<
      typeof import("@bb/shared-ui/hooks/use-media-query")
    >();
  return {
    ...actual,
    useMediaQuery: (query: string) =>
      query === "(pointer: coarse)"
        ? testState.touchEnabled
        : actual.useMediaQuery(query),
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
    keybindings: [],
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  testState.clearAttention.mockReset();
  testState.output.mockReset();
  testState.screen.mockReset();
  testState.toastError.mockReset();
  testState.touchEnabled = false;
});

function stubViewportLayout({
  viewportWidth,
  containerWidth,
  containerHeight,
  cellWidth,
  fittedCols,
  fittedRows,
  touch,
  getTerminal,
}: {
  viewportWidth: number;
  containerWidth: number;
  containerHeight: number;
  cellWidth: number;
  fittedCols: number;
  fittedRows: number;
  touch: boolean;
  getTerminal: () => Terminal | null;
}) {
  testState.touchEnabled = touch;
  vi.stubGlobal("innerWidth", viewportWidth);
  const baseMatchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...baseMatchMedia(query),
    media: query,
    matches:
      query === COMPACT_VIEWPORT_QUERY
        ? viewportWidth <= 767
        : query === "(pointer: coarse)"
          ? touch
          : false,
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * cellWidth }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    containerWidth,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    containerHeight,
  );
  const baseGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const computed = baseGetComputedStyle(element, pseudo);
    if (element instanceof HTMLElement && element.classList.contains("xterm")) {
      return new Proxy(computed, {
        get(target, prop, receiver) {
          if (prop === "paddingLeft") return "8px";
          if (prop === "paddingRight") return "14px";
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return computed;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("xterm-screen")) {
        const cols = getTerminal()?.cols ?? fittedCols;
        const naturalWidth = cols * cellWidth;
        const surface = this.closest<HTMLElement>(".xterm");
        const transform = surface?.style.transform ?? "";
        const width = transform.includes("100cqw")
          ? Math.min(naturalWidth, containerWidth)
          : naturalWidth;
        return new DOMRect(0, 0, width, containerHeight);
      }
      return new DOMRect(0, 0, containerWidth, containerHeight);
    },
  );
  vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue({
    cols: fittedCols,
    rows: fittedRows,
  });
}

describe("ended native terminal transcript rendering", () => {
  it("reveals and reflows an ended native terminal transcript on 1440px desktop when recorded cols exceed DOM fit", async () => {
    let activeTerminal: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      activeTerminal = this;
      open.call(this, element);
    });
    stubViewportLayout({
      viewportWidth: 1440,
      containerWidth: 1140,
      containerHeight: 720,
      cellWidth: 8.5,
      fittedCols: 130,
      fittedRows: 38,
      touch: false,
      getTerminal: () => activeTerminal,
    });
    testState.output.mockResolvedValue({
      chunks: [
        {
          seq: 0,
          dataBase64: btoa("\x1b]7791;bb-grid;135;41\x07delta\r\nepsilon\r\n"),
        },
      ],
      nextSeq: 1,
    });

    const view = render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            retainNativeOutput
            session={makeTerminalSession({
              status: "exited",
              exitCode: 0,
              cols: 135,
              rows: 41,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const host = view.container.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      );
      expect(host?.style.opacity).toBe("");
      expect(host?.dataset.renderGridCols).toBe("130");
      expect(host?.dataset.renderGridRows).toBe("38");
    });

    await act(async () => {
      await new Promise<void>((resolve) => activeTerminal!.write("", resolve));
    });

    const host = view.container.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    const surface = host.querySelector<HTMLElement>(".xterm")!;
    expect(view.container.querySelector(".xterm-rows")?.textContent).toContain(
      "delta",
    );
    expect(view.container.querySelector(".xterm-rows")?.textContent).toContain(
      "epsilon",
    );
    expect(surface.style.transform).toBe("scale(1)");
    expect(host.style.overflowX).toBe("");
    expect(host.style.overflowY).toBe("");
  });

  it("reflows an ended native terminal transcript to 390px phone width and renders no terminal key rows", async () => {
    let activeTerminal: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      activeTerminal = this;
      open.call(this, element);
    });
    stubViewportLayout({
      viewportWidth: 390,
      containerWidth: 390,
      containerHeight: 520,
      cellWidth: 7.8,
      fittedCols: 46,
      fittedRows: 28,
      touch: true,
      getTerminal: () => activeTerminal,
    });
    const longLine = `ALPHA-${"w".repeat(80)}-OMEGA`;
    testState.output.mockResolvedValue({
      chunks: [
        {
          seq: 0,
          dataBase64: btoa(`\x1b]7791;bb-grid;135;41\x07${longLine}\r\n`),
        },
      ],
      nextSeq: 1,
    });

    const view = render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            retainNativeOutput
            session={makeTerminalSession({
              status: "exited",
              exitCode: 0,
              cols: 135,
              rows: 41,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const host = view.container.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      );
      expect(host?.style.opacity).toBe("");
      expect(host?.dataset.renderGridCols).toBe("46");
      expect(host?.dataset.renderGridRows).toBe("28");
    });

    await act(async () => {
      await new Promise<void>((resolve) => activeTerminal!.write("", resolve));
    });

    const host = view.container.querySelector<HTMLElement>(
      "[data-terminal-renderer]",
    )!;
    expect(host.style.overflowX).toBe("");
    expect(host.style.overflowY).toBe("");
    expect(host.style.touchAction).toBe("");
    expect(host.parentElement?.classList.contains("touch-pan-x")).toBe(false);
    expect(host.parentElement?.classList.contains("touch-pan-y")).toBe(true);
    const controls = screen.getByRole("group", {
      name: "Terminal keyboard controls",
    });
    expect(controls.children).toHaveLength(1);
    for (const label of [
      "Interrupt (Control C)",
      "Escape",
      "Tab",
      "Enter",
      "Control for next key",
      "Arrow left",
      "Arrow right",
      "Arrow up",
      "Arrow down",
      "More terminal keys",
    ]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    for (const label of [
      "Previous prompt",
      "Next prompt",
      "Select terminal text",
    ]) {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: label }).disabled,
      ).toBe(false);
    }

    const buffer = activeTerminal!.buffer.active;
    const lines = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    );
    expect(lines.every((line) => line.length <= 46)).toBe(true);
    expect(lines.join("")).toContain(longLine);
  });

  it("keeps read-only controls enabled and renders no typing-key rows on an ended terminal at 390px phone width", async () => {
    let activeTerminal: Terminal | null = null;
    const open = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
      this: Terminal,
      element: HTMLElement,
    ) {
      activeTerminal = this;
      open.call(this, element);
    });
    stubViewportLayout({
      viewportWidth: 390,
      containerWidth: 390,
      containerHeight: 520,
      cellWidth: 7.8,
      fittedCols: 46,
      fittedRows: 28,
      touch: true,
      getTerminal: () => activeTerminal,
    });
    testState.output.mockResolvedValue({
      chunks: [{ seq: 0, dataBase64: btoa("done\r\n") }],
      nextSeq: 1,
    });

    const view = render(
      <MemoryRouter>
        <AppCommandProvider>
          <ThreadTerminalView
            autoFocus={false}
            isPanelOpen
            retainNativeOutput
            session={makeTerminalSession({
              status: "exited",
              exitCode: 0,
              cols: 46,
              rows: 28,
            })}
          />
        </AppCommandProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const host = view.container.querySelector<HTMLElement>(
        "[data-terminal-renderer]",
      );
      expect(host?.style.opacity).toBe("");
    });

    const controls = screen.getByRole("group", {
      name: "Terminal keyboard controls",
    });
    expect(controls.children).toHaveLength(1);
    for (const label of [
      "Interrupt (Control C)",
      "Escape",
      "Tab",
      "Enter",
      "Control for next key",
      "Arrow left",
      "Arrow right",
      "Arrow up",
      "Arrow down",
      "More terminal keys",
    ]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    for (const label of [
      "Previous prompt",
      "Next prompt",
      "Select terminal text",
    ]) {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: label }).disabled,
      ).toBe(false);
    }
  });
});
