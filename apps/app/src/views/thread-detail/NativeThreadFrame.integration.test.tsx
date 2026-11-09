// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { FitAddon } from "@xterm/addon-fit";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { RetainedTerminalViewsProvider } from "@/components/thread/terminal/RetainedTerminalViews";
import { importTerminalModules } from "@/components/thread/terminal/terminal-modules";
import * as renderer from "@/components/thread/terminal/terminal-webgl-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { DefaultPaneContextProvider } from "./PaneContext";
import { useThreadFrameState } from "./ThreadFrameState";
import {
  createEmptyFixedPanelTabsState,
  getFixedPanelTabsStateStorageKey,
  serializeFixedPanelTabsState,
  createThreadInfoFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { getThreadSecondaryPanelWidthPercentAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { whenRouteSurfaceMounted } from "@/lib/plugin-frontend-boot-schedule";
import {
  LazyThreadDetailView,
  preloadNativeThreadFrame,
} from "./LazyThreadDetailView";

const pending = vi.hoisted(() => {
  return {
    interactionsPending: true,
    placeholder: true,
    nativePending: false,
    metadataThreadId: "thr_early",
    chat: false,
    wires: [] as string[],
    screens: vi.fn(),
    recordPending: false,
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
const fixedTab = createThreadInfoFixedPanelTab();
const tabs = { tabs: [fixedTab], revision: 1 };
vi.mock("@/lib/split-prefetch", () => ({
  prepareSplitImport: async () => {},
  trackCriticalLoad: (promise: Promise<unknown>) => promise,
  queueSplitPreload: () => {},
  queueSplitDownload: () => {},
}));

vi.mock("@/hooks/queries/thread-queries", async (original) => ({
  ...(await original<typeof import("@/hooks/queries/thread-queries")>()),
  useThread: () => ({
    isPlaceholderData: pending.placeholder,
    data: pending.recordPending
      ? undefined
      : pending.chat
        ? { ...thread, nativeTerminal: false }
        : thread,
  }),
  useThreadDetailBootstrap: () => ({}),
  useThreads: () => ({ data: [] }),
  useThreadPendingInteractions: () => ({
    data: [],
    isPending: pending.interactionsPending,
    isSuccess: !pending.interactionsPending,
  }),
}));
vi.mock("@/hooks/queries/native-terminal-queries", async (original) => ({
  ...(await original<
    typeof import("@/hooks/queries/native-terminal-queries")
  >()),
  useOpenNativeTerminal: () => ({ isPending: false, mutate: vi.fn() }),
  useNativeTerminalThread: () => ({
    dataUpdatedAt: 1,
    refetch: vi.fn(),
    data: pending.nativePending
      ? undefined
      : pending.chat
        ? null
        : { ...view, threadId: pending.metadataThreadId },
    isPending: pending.nativePending,
  }),
}));
vi.mock("@/hooks/queries/environment-queries", async (original) => ({
  ...(await original<typeof import("@/hooks/queries/environment-queries")>()),
  useEnvironment: () => ({ data: environment, isPending: false }),
}));
vi.mock("@/hooks/queries/thread-tabs-query", () => ({
  useThreadTabs: () => ({ data: tabs, isPending: false, isSuccess: true }),
}));
vi.mock("@/hooks/queries/system-queries", async (original) => ({
  ...(await original<typeof import("@/hooks/queries/system-queries")>()),
  useProviderOptions: () => ({ data: [] }),
  useSystemConfig: () => ({
    data: {
      experiments: {},
      generalSettings: { showKeyboardHints: false },
      nativeTerminal: { copyOnSelect: false },
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
vi.mock("@/components/plugin/PluginThreadContextCard", async (original) => ({
  ...(await original<
    typeof import("@/components/plugin/PluginThreadContextCard")
  >()),
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
vi.mock("@/lib/sdk", async () => ({
  BbHttpError: (await import("@bb/sdk/browser")).BbHttpError,
  sdk: {
    threads: {
      executionProfile: async () => null,
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
vi.mock("@/views/thread-detail/useThreadDetailThread", () => ({
  useThreadDetailThread: () => ({
    hasThreadDetailBootstrapSettled: true,
    thread: pending.chat ? { ...thread, nativeTerminal: false } : thread,
    threadDetailBootstrapQuery: { isFetching: false },
    threadQuery: {
      data: thread,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    },
    unreadDividerState: { ready: true, anchor: null },
  }),
}));
vi.mock("@/hooks/queries/thread-terminal-queries", async (original) => ({
  ...(await original<
    typeof import("@/hooks/queries/thread-terminal-queries")
  >()),
  useThreadTerminals: () => ({
    data: { sessions: [view.terminal] },
    dataUpdatedAt: 1,
  }),
}));
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(async () => {
  history.replaceState({}, "", "/");
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  localStorage.clear();
  resetPluginFrontendBootStateForTest();
  resetFixedPanelTabsStateForTest();
  history.replaceState({}, "", "/");
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

function Fixture({
  client,
  store = createStore(),
}: {
  client: QueryClient;
  store?: ReturnType<typeof createStore>;
}) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/threads/${thread.id}`]}>
        <AppCommandProvider>
          <RetainedTerminalViewsProvider>
            <Provider store={store}>
              <DefaultPaneContextProvider
                paneId="main"
                onRequestClose={null}
                navigateInPane={() => {}}
              >
                <LazyThreadDetailView
                  surface="pane"
                  projectId={thread.projectId}
                  threadId={thread.id}
                  timelineEnabled={false}
                />
              </DefaultPaneContextProvider>
            </Provider>
          </RetainedTerminalViewsProvider>
        </AppCommandProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const claims = () =>
  pending.wires
    .map((raw) => JSON.parse(raw))
    .filter((message) => message.type === "resize");
const panelSizes = () =>
  [...document.querySelectorAll("[data-panel-size]")].map((node) =>
    Number(node.getAttribute("data-panel-size")),
  );

it("enters the real chat detail without waiting for native metadata or loading the native frame", async () => {
  const paint = await prepareTerminal();
  const marks = vi.spyOn(performance, "mark");
  pending.chat = true;
  pending.nativePending = true;
  pending.recordPending = true;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(<Fixture client={client} />);
  await act(async () => {
    await LazyThreadDetailView.preload();
  });
  await paint();
  expect(
    document.querySelector("[data-testid=route-loading-skeleton]"),
  ).toBeNull();
  expect(document.querySelector("header")).not.toBeNull();
  pending.recordPending = false;
  rendered.rerender(<Fixture client={client} />);
  await paint();
  expect(document.querySelector("header")).not.toBeNull();
  expect(document.querySelector("[data-native-terminal-thread]")).toBeNull();
  expect(marks.mock.calls.map(([name]) => name)).not.toContain(
    "terminal-split-native-thread-frame-import-start",
  );
});

it("keeps the existing frame when an unidentified route resolves to a native thread later", async () => {
  const paint = await prepareTerminal();
  const marks = vi.spyOn(performance, "mark");
  pending.chat = false;
  pending.nativePending = true;
  pending.recordPending = true;
  pending.placeholder = false;
  pending.wires.length = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  const rendered = render(<Fixture client={client} store={store} />);
  await act(async () => {
    await LazyThreadDetailView.preload();
  });
  await paint();
  const group = document.querySelector("[data-panel-group]");
  expect(group).not.toBeNull();
  expect(document.querySelector(".xterm")).toBeNull();
  pending.nativePending = false;
  pending.recordPending = false;
  rendered.rerender(<Fixture client={client} store={store} />);
  await act(async () => {
    await (
      await import("@/components/thread/terminal/native-terminal-panel-loader")
    ).loadNativeTerminalPanel();
  });
  await paint();
  expect(document.querySelector(".xterm")).not.toBeNull();
  expect(document.querySelector("[data-panel-group]")).toBe(group);
  expect(claims()).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  expect(marks.mock.calls.map(([name]) => name)).not.toContain(
    "terminal-split-native-thread-frame-import-start",
  );
});

it.each([false, true])(
  "mounts the real native main before deferred plugin boot, retaining its final slot and one claim (panel open: %s)",
  async (open) => {
    const paint = await prepareTerminal();
    pending.placeholder = false;
    pending.interactionsPending = false;
    pending.chat = false;
    pending.nativePending = false;
    pending.recordPending = false;
    pending.wires.length = 0;
    history.replaceState({}, "", `/threads/${thread.id}`);
    const bootSettled = vi.fn();
    const boot = whenRouteSurfaceMounted().then(() => {
      markPluginFrontendsSettled();
      bootSettled();
    });
    const store = createStore();
    store.set(getThreadSecondaryPanelWidthPercentAtom(thread.id), 35);
    const state = createEmptyFixedPanelTabsState({ lastUsedAt: Date.now() });
    localStorage.setItem(
      getFixedPanelTabsStateStorageKey({ threadId: thread.id }),
      serializeFixedPanelTabsState({
        state: {
          ...state,
          secondary: {
            ...state.secondary,
            activeTabId: fixedTab.id,
            tabs: [fixedTab],
            isOpen: open,
          },
        },
      }),
    );
    resetFixedPanelTabsStateForTest();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    expect(bootSettled).not.toHaveBeenCalled();
    render(<Fixture client={client} store={store} />);
    await act(async () => {
      await preloadNativeThreadFrame();
    });
    await act(async () => {
      await (
        await import("@/components/thread/terminal/native-terminal-panel-loader")
      ).loadNativeTerminalPanel();
    });
    await paint();
    const terminal = document.querySelector(
      "[data-native-terminal-thread] .xterm",
    );
    expect(terminal).not.toBeNull();
    const slot = document.querySelector(
      "[data-native-terminal-thread]",
    )!.firstElementChild;
    expect(claims()).toEqual([
      { type: "resize", cols: 116, rows: 36, claim: true },
    ]);
    expect(panelSizes()).toEqual(open ? [65, 35] : [100, 0]);
    await act(async () => {
      await boot;
      await import("./ThreadDetailView");
      await LazyThreadDetailView.preload();
    });
    await paint();
    expect(LazyThreadDetailView.isLoaded()).toBe(true);
    expect(document.querySelector("[data-native-terminal-thread] .xterm")).toBe(
      terminal,
    );
    expect(
      document.querySelector("[data-native-terminal-thread]")!
        .firstElementChild,
    ).toBe(slot);
    expect(panelSizes()).toEqual(open ? [65, 35] : [100, 0]);
    expect(claims()).toHaveLength(1);
    expect(bootSettled).toHaveBeenCalledOnce();
  },
);
