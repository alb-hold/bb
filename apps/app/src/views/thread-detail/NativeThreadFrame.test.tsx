// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { useAtomValue, createStore } from "jotai";
import {
  getThreadSecondaryPanelWidthPercentAtom,
  SecondaryPanelWidthPercentAtomContext,
} from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { SecondaryPanelMinimumContext } from "@/components/secondary-panel/secondaryPanelSizing";
import { NativeThreadDeferredPanel } from "./NativeThreadFrameContext";
import {
  useThreadFrameState,
  useOptionalThreadFrameState,
} from "./ThreadFrameState";
import { createPluginFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { MemoryRouter } from "react-router-dom";
import { FitAddon } from "@xterm/addon-fit";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadTerminalView } from "@/components/thread/terminal/ThreadTerminalView";
import {
  RetainedTerminalViewsProvider,
  RetainedTerminalViewSlot,
} from "@/components/thread/terminal/RetainedTerminalViews";
import { importTerminalModules } from "@/components/thread/terminal/terminal-modules";
import * as renderer from "@/components/thread/terminal/terminal-webgl-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import {
  DefaultPaneContextProvider,
  PaneContext,
  usePaneContext,
  createPaneSecondaryPanelRegistry,
} from "./PaneContext";
import { SplitWorkspaceSecondaryPanelHost } from "./SplitWorkspaceSecondaryPanelHost";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import {
  LazyThreadDetailView,
  preloadNativeThreadFrame,
} from "./LazyThreadDetailView";

const pending = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve,
    interactionsPending: true,
    placeholder: true,
    nativePending: false,
    metadataThreadId: "thr_early",
    chat: false,
    wires: [] as string[],
    screens: vi.fn(),
    controllerVisible: true,
  };
});
const thread = makeThreadResponse({
  id: "thr_early",
  projectId: "proj_early",
  environmentId: "env_early",
  nativeTerminal: true,
});
const environment = makeEnvironment({
  id: "env_early",
  projectId: "proj_early",
});
const view = {
  threadId: thread.id,
  providerId: "codex",
  displayName: "Codex",
  model: null,
  nativeSessionId: "session_early",
  canReturnToChat: true,
  terminal: makeTerminalSession({ threadId: thread.id }),
};
const fixedTab = createPluginFixedPanelTab({
  pluginId: "fixture",
  tabId: "info",
});
const fixedEntries = [{ tab: fixedTab }];
const tabs = { tabs: [fixedTab], revision: 1 };
vi.mock("./ThreadDetailView", async () => {
  await pending.promise;
  return {
    ThreadDetailView: () =>
      pending.controllerVisible ? <DeferredController /> : null,
  };
});
vi.mock("@/lib/split-prefetch", () => ({
  prepareSplitImport: async () => {},
  trackCriticalLoad: (promise: Promise<unknown>) => promise,
  queueSplitPreload: () => {},
}));
vi.mock("@/hooks/useRouteState", () => ({ useRouteState: () => ({}) }));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    isPlaceholderData: pending.placeholder,
    data: pending.chat ? { ...thread, nativeTerminal: false } : thread,
  }),
  useThreadDetailBootstrap: () => ({}),
  useThreadPendingInteractions: () => ({
    data: [],
    isPending: pending.interactionsPending,
    isSuccess: !pending.interactionsPending,
  }),
}));
vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({
    data: { ...view, threadId: pending.metadataThreadId },
    isPending: pending.nativePending,
  }),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: environment, isPending: false }),
}));
vi.mock("@/hooks/queries/thread-tabs-query", () => ({
  useThreadTabs: () => ({ data: tabs, isPending: false, isSuccess: true }),
}));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      experiments: {},
      generalSettings: { showKeyboardHints: false },
      keybindings: [],
    },
  }),
}));
vi.mock("@/hooks/useLiveFileOpenTargets", () => ({
  useLiveFileOpenTargets: () => ({
    directoryOpenTargets: [],
    canOpenPreferredDirectoryTarget: false,
  }),
}));
vi.mock("@/components/plugin/PluginThreadFixedTabs", () => ({
  useThreadFixedTabs: () => ({
    entries: fixedEntries,
    observers: null,
    isReady: true,
  }),
}));
vi.mock("@/components/plugin/PluginThreadContextCard", () => ({
  ThreadContextCardProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("./ThreadFrameHeader", () => ({
  ThreadFrameHeader: () => {
    const state = useThreadFrameState();
    return (
      <header>
        Native header
        <button onClick={state.toggleDefaultPersistedSecondaryPanel}>
          Open details
        </button>
        <button onClick={state.closeThreadSecondaryPanel}>Close details</button>
      </header>
    );
  },
}));
vi.mock("./ThreadContextCardCore", () => ({
  CORE_THREAD_CONTEXT_CARD_ROWS: [],
  CORE_THREAD_CONTEXT_CARD_SECTIONS: [],
}));
vi.mock("@/components/thread/terminal/NativeThreadTerminalMain", () => ({
  NativeThreadTerminalMain: () => (
    <div data-native-terminal-thread="codex">
      <RetainedTerminalViewSlot
        View={ThreadTerminalView}
        session={view.terminal}
        isPanelOpen
        autoFocus={false}
      />
    </div>
  ),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      tabs: {
        get: async () => tabs,
        update: async (args: { tabs: unknown[] }) => ({
          tabs: args.tabs,
          revision: 1,
        }),
      },
    },
    terminals: {
      experimental_screen: pending.screens,
      output: pending.screens,
      experimental_attention: { clear: vi.fn() },
    },
  },
}));
vi.mock("@/hooks/usePluginCommandBindings", () => ({
  usePluginCommandBindings: () => ({
    commands: [],
    defaults: [],
    keybindings: [],
  }),
}));

class NativeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  protocol = "bb.terminal.replay-batch.v1";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.receive({
        type: "attached",
        session: view.terminal,
        replayStartSeq: 0,
        nextSeq: 1,
      });
      this.receive({
        type: "output-batch",
        chunks: [{ seq: 0, dataBase64: btoa("Existing native session\r\n") }],
      });
    });
  }
  receive(message: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
  send(raw: string) {
    pending.wires.push(raw);
    const message = JSON.parse(raw);
    if (message.type === "resize")
      queueMicrotask(() =>
        this.receive({
          type: "session-updated",
          session: { ...view.terminal, cols: message.cols, rows: message.rows },
        }),
      );
  }
  close() {
    this.readyState = 3;
  }
}
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  localStorage.clear();
});

async function prepareTerminal() {
  pending.screens.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("WebSocket", NativeSocket);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  for (const dimension of [
    "clientWidth",
    "offsetWidth",
    "clientHeight",
    "offsetHeight",
  ] as const)
    vi.spyOn(HTMLElement.prototype, dimension, "get").mockReturnValue(504);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 504,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 504,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(FitAddon.prototype, "proposeDimensions").mockImplementation(() => {
    expect(
      document.querySelector("[data-native-terminal-thread] .xterm"),
    ).not.toBeNull();
    return { cols: 116, rows: 36 };
  });
  vi.spyOn(renderer, "loadOptionalTerminalWebglAddon").mockResolvedValue(null);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      status: "loaded",
      ready: Promise.resolve(),
    }),
  });
  await importTerminalModules();
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.useFakeTimers();
  return async () => {
    for (let index = 0; index < 24; index++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
        const ready = [...frames.values()];
        frames.clear();
        ready.forEach((callback) => callback(performance.now()));
      });
  };
}

it("keeps the final native slot while the detail module resolves and holds it until essential extents settle", async () => {
  const paint = await prepareTerminal();
  const store = createStore();
  store.set(getThreadSecondaryPanelWidthPercentAtom(thread.id), 35);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const registry = createPaneSecondaryPanelRegistry();
  const registration = {
    publish: (model: Parameters<typeof registry.publish>[1]) =>
      registry.publish("main", model),
    clear: () => registry.clear("main"),
  };
  function HostedPane({ children }: { children: ReactNode }) {
    const pane = usePaneContext();
    return (
      <PaneContext.Provider
        value={{ ...pane, secondaryPanelHost: registration }}
      >
        {children}
      </PaneContext.Provider>
    );
  }
  function Fixture({
    projectId = thread.projectId,
    hosted = false,
  }: {
    projectId?: string;
    hosted?: boolean;
  }) {
    const detail = (
      <LazyThreadDetailView
        surface="pane"
        projectId={projectId}
        threadId={thread.id}
        timelineEnabled={false}
      />
    );
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AppCommandProvider>
            <RetainedTerminalViewsProvider>
              <Provider store={store}>
                <DefaultPaneContextProvider
                  paneId="main"
                  onRequestClose={null}
                  navigateInPane={() => {}}
                >
                  {hosted ? (
                    <SplitWorkspaceSecondaryPanelHost
                      registry={registry}
                      focusedPaneId="main"
                      isPaneMaximized={false}
                    >
                      <HostedPane>{detail}</HostedPane>
                    </SplitWorkspaceSecondaryPanelHost>
                  ) : (
                    detail
                  )}
                </DefaultPaneContextProvider>
              </Provider>
            </RetainedTerminalViewsProvider>
          </AppCommandProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const rendered = render(<Fixture />);
  await act(async () => {
    await preloadNativeThreadFrame();
  });
  expect(screen.queryByText("Native header")).toBeNull();
  pending.placeholder = false;
  rendered.rerender(<Fixture />);
  expect(screen.getByText("Native header")).toBeTruthy();
  expect(
    document.querySelector("[data-native-terminal-thread] .xterm"),
  ).toBeNull();
  expect(screen.queryByTestId("detail-controller")).toBeNull();
  await act(async () => screen.getByText("Open details").click());
  pending.interactionsPending = false;
  rendered.rerender(<Fixture />);
  await paint();
  const terminal = document.querySelector(
    "[data-native-terminal-thread] .xterm",
  );
  expect(terminal).not.toBeNull();
  const slot = document.querySelector(
    "[data-native-terminal-thread]",
  )!.firstElementChild!;
  expect(slot.contains(terminal)).toBe(true);
  const panelSizes = () =>
    Array.from(document.querySelectorAll("[data-panel-size]")).map((node) =>
      Number(node.getAttribute("data-panel-size")),
    );
  expect(panelSizes()).toEqual([65, 35]);
  const resizes = () =>
    pending.wires
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.type === "resize");
  expect(resizes()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  expect(document.querySelector('[data-replay-held="false"]')).not.toBeNull();
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  await paint();
  expect(screen.getByTestId("detail-controller")).toBeTruthy();
  expect(panelSizes()).toEqual([65, 35]);
  expect(document.querySelector("[data-native-terminal-thread] .xterm")).toBe(
    terminal,
  );
  expect(
    document.querySelector("[data-native-terminal-thread]")!.firstElementChild,
  ).toBe(slot);
  expect(resizes()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  for (const open of [false, true]) {
    await act(async () =>
      screen.getByText(open ? "Open details" : "Close details").click(),
    );
    await paint();
    const expected = open ? [65, 35] : [100, 0];
    expect(panelSizes()).toEqual(expected);
    pending.controllerVisible = false;
    rendered.rerender(<Fixture />);
    await paint();
    expect(panelSizes()).toEqual(expected);
    pending.controllerVisible = true;
    rendered.rerender(<Fixture />);
    await paint();
    expect(panelSizes()).toEqual(expected);
    expect(
      document.querySelector("[data-native-terminal-thread]")!
        .firstElementChild,
    ).toBe(slot);
  }
  pending.interactionsPending = true;
  rendered.rerender(<Fixture />);
  await paint();
  expect(document.querySelector("[data-native-terminal-thread] .xterm")).toBe(
    terminal,
  );
  expect(resizes()).toHaveLength(1);
  rendered.unmount();
  pending.wires.length = 0;
  pending.interactionsPending = false;
  const reopened = render(<Fixture />);
  await paint();
  expect(
    document.querySelector("[data-native-terminal-thread] .xterm"),
  ).not.toBeNull();
  expect(resizes()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  await act(async () => screen.getByText("Close details").click());
  reopened.unmount();
  pending.wires.length = 0;
  pending.controllerVisible = false;
  const closed = render(<Fixture />);
  await paint();
  expect(panelSizes()).toEqual([100, 0]);
  const closedSlot = document.querySelector(
    "[data-native-terminal-thread]",
  )!.firstElementChild;
  const closedTerminal = document.querySelector(
    "[data-native-terminal-thread] .xterm",
  );
  expect(closedTerminal).not.toBeNull();
  expect(resizes()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  pending.controllerVisible = true;
  closed.rerender(<Fixture />);
  await paint();
  expect(panelSizes()).toEqual([100, 0]);
  expect(
    document.querySelector("[data-native-terminal-thread]")!.firstElementChild,
  ).toBe(closedSlot);
  expect(document.querySelector("[data-native-terminal-thread] .xterm")).toBe(
    closedTerminal,
  );
  expect(resizes()).toHaveLength(1);
  closed.unmount();
  pending.wires.length = 0;
  pending.controllerVisible = false;
  const hosted = render(<Fixture hosted />);
  await act(async () => screen.getByText("Open details").click());
  await paint();
  expect(panelSizes()).toEqual([65, 35]);
  const reservation = screen.getByTestId(
    "thread-secondary-panel-placeholder",
  ).previousElementSibling;
  expect(reservation).not.toBeNull();
  expect(getComputedStyle(reservation!).width).toBe("1px");
  const hostedSlot = document.querySelector(
    "[data-native-terminal-thread]",
  )!.firstElementChild;
  const hostedTerminal = document.querySelector(
    "[data-native-terminal-thread] .xterm",
  );
  expect(hostedTerminal).not.toBeNull();
  expect(resizes()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  pending.controllerVisible = true;
  hosted.rerender(<Fixture hosted />);
  await paint();
  expect(panelSizes()).toEqual([65, 35]);
  expect(
    document.querySelector("[data-native-terminal-thread]")!.firstElementChild,
  ).toBe(hostedSlot);
  expect(document.querySelector("[data-native-terminal-thread] .xterm")).toBe(
    hostedTerminal,
  );
  expect(
    getComputedStyle(document.querySelector("[data-panel-resize-handle-id]")!)
      .width,
  ).toBe("1px");
  expect(resizes()).toHaveLength(1);
  hosted.unmount();
  pending.wires.length = 0;
  const wrongProject = render(<Fixture projectId="proj_wrong" />);
  await paint();
  expect(screen.queryByText("Native header")).toBeNull();
  expect(resizes()).toHaveLength(0);
  wrongProject.unmount();
  pending.metadataThreadId = "thr_other";
  const wrongMetadata = render(<Fixture />);
  await paint();
  expect(screen.queryByText("Native header")).toBeNull();
  expect(resizes()).toHaveLength(0);
  wrongMetadata.unmount();
  pending.chat = true;
  pending.nativePending = true;
  const chat = render(<Fixture />);
  await paint();
  expect(screen.getByTestId("detail-controller")).toBeTruthy();
  expect(screen.queryByText("Native header")).toBeNull();
  expect(resizes()).toHaveLength(0);
  chat.unmount();
  client.clear();
});

function DeferredController() {
  const state = useOptionalThreadFrameState();
  if (!state) return <div data-testid="detail-controller" />;
  return (
    <NativeThreadDeferredPanel
      renderPanel={({ resizablePanelId, isMainCollapsed }) => (
        <DeferredPanel
          open={state.isSecondaryPanelOpen}
          id={resizablePanelId}
          collapsed={isMainCollapsed}
        />
      )}
    />
  );
}
function DeferredPanel({
  open,
  id,
  collapsed,
}: {
  open: boolean;
  id?: string;
  collapsed: boolean;
}) {
  const width = useAtomValue(useContext(SecondaryPanelWidthPercentAtomContext));
  const minimum = useContext(SecondaryPanelMinimumContext);
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  return (
    <>
      <PanelResizeHandle
        disabled={!open}
        style={{
          width: hostLayout !== null && open && !collapsed ? 1 : 0,
          flexShrink: 0,
        }}
      />
      <Panel
        id={id}
        order={2}
        collapsible
        collapsedSize={0}
        defaultSize={open ? (collapsed ? 100 : width) : 0}
        minSize={(1 - minimum.max) * 100}
        maxSize={collapsed ? 100 : (1 - minimum.min) * 100}
      >
        <div data-testid="detail-controller" />
      </Panel>
    </>
  );
}
