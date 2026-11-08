// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "./app-query-client";
import { prefetchThreadOpen } from "./thread-open-prefetch";
import { sdk } from "./sdk";
import {
  nativeTerminalThreadQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";

const { readThread, warmNativePanel } = vi.hoisted(() => ({
  warmNativePanel: vi.fn(() => Promise.resolve(null)),
  readThread: vi.fn(() => Promise.resolve({ id: "native" })),
}));

vi.mock("@/components/thread/terminal/native-terminal-panel-loader", () => ({
  loadNativeTerminalPanel: warmNativePanel,
}));

vi.mock("./sdk", () => ({ sdk: { nativeTerminals: { get: vi.fn() } } }));
vi.mock("./ws", () => ({
  wsManager: { getDeviceHandoffClientToken: () => undefined },
}));
vi.mock("@/components/thread/terminal/terminal-socket-prefetch", () => ({
  prefetchTerminalSocket: vi.fn(),
}));
vi.mock("@/components/thread/terminal/terminal-screen-prefetch", () => ({
  prefetchTerminalScreen: vi.fn(),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  threadQueryOptions: (_client: unknown, id: string) => ({
    queryKey: threadQueryKey(id),
    queryFn: readThread,
    staleTime: 30_000,
  }),
  threadDetailBootstrapQueryOptions: (
    _client: unknown,
    id: string,
    options: object,
  ) => ({
    queryKey: ["bootstrap", id],
    queryFn: () => new Promise(() => {}),
    ...options,
  }),
}));
vi.mock("@/components/thread/terminal/terminal-modules", () => ({
  preloadTerminalModules: vi.fn(),
}));
vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: { preload: vi.fn() },
}));

afterEach(() => {
  window.history.replaceState({}, "", "/");
  appQueryClient.clear();
  vi.clearAllMocks();
});

it.each(["/threads/native", "/projects/proj/threads/native"])(
  "connects cached metadata on navigation to %s while hover only warms it",
  async (pathname) => {
    vi.mocked(sdk.nativeTerminals.get).mockResolvedValue({
      threadId: "native",
      providerId: "codex",
      displayName: "Codex",
      nativeSessionId: null,
      model: null,
      canReturnToChat: true,
      terminal: { id: "term-active", status: "running" },
    } as Awaited<ReturnType<typeof sdk.nativeTerminals.get>>);
    prefetchThreadOpen("native");
    await vi.waitFor(() =>
      expect(preloadTerminalModules).toHaveBeenCalledOnce(),
    );
    expect(prefetchTerminalSocket).not.toHaveBeenCalled();
    window.history.replaceState({}, "", pathname);
    prefetchThreadOpen("native");
    await vi.waitFor(() =>
      expect(prefetchTerminalSocket).toHaveBeenCalledWith(
        expect.stringContaining("term-active"),
      ),
    );
    expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce();
  },
);

it("does not attach when navigation leaves before native metadata resolves", async () => {
  type View = Awaited<ReturnType<typeof sdk.nativeTerminals.get>>;
  let resolveMetadata: ((value: View) => void) | undefined;
  vi.mocked(sdk.nativeTerminals.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
  );
  window.history.replaceState({}, "", "/threads/native");
  prefetchThreadOpen("native");
  await vi.waitFor(() =>
    expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce(),
  );
  window.history.replaceState({}, "", "/threads/another");
  resolveMetadata?.({
    threadId: "native",
    providerId: "codex",
    displayName: "Codex",
    nativeSessionId: null,
    model: null,
    canReturnToChat: true,
    terminal: { id: "term-active", status: "running" },
  } as View);
  await vi.waitFor(() =>
    expect(
      appQueryClient.getQueryState(nativeTerminalThreadQueryKey("native"))
        ?.fetchStatus,
    ).toBe("idle"),
  );
  expect(prefetchTerminalSocket).not.toHaveBeenCalled();
});

it("opens a cached terminal synchronously while bootstrap remains pending and no general socket token exists", () => {
  window.history.replaceState({}, "", "/threads/native");
  appQueryClient.setQueryData(nativeTerminalThreadQueryKey("native"), {
    terminal: { id: "term-cached", status: "running" },
  });
  prefetchThreadOpen("native");
  expect(prefetchTerminalSocket).toHaveBeenCalledWith(
    expect.stringContaining("term-cached"),
  );
  expect(
    appQueryClient.getQueryState(["bootstrap", "native"])?.fetchStatus,
  ).toBe("fetching");
});

it("starts native discovery while thread bootstrap is pending and warms a native terminal", async () => {
  vi.mocked(sdk.nativeTerminals.get).mockResolvedValue({
    threadId: "native",
    providerId: "codex",
    displayName: "Codex",
    nativeSessionId: null,
    model: null,
    canReturnToChat: true,
    terminal: null,
  });
  prefetchThreadOpen("native");
  await vi.waitFor(() => expect(preloadTerminalModules).toHaveBeenCalledOnce());
  expect(
    appQueryClient.getQueryState(["bootstrap", "native"])?.fetchStatus,
  ).toBe("fetching");
  expect(LazyThreadTerminalPanel.preload).toHaveBeenCalledOnce();
});

it("fills the native thread record before the detail view mounts while bootstrap is pending", async () => {
  window.history.replaceState({}, "", "/threads/native");
  appQueryClient.setQueryData(nativeTerminalThreadQueryKey("native"), {
    terminal: { id: "term-cached", status: "running" },
  });
  prefetchThreadOpen("native");
  await vi.waitFor(() =>
    expect(appQueryClient.getQueryData(threadQueryKey("native"))).toEqual({
      id: "native",
    }),
  );
  expect(readThread).toHaveBeenCalledOnce();
  expect(
    appQueryClient.getQueryState(["bootstrap", "native"])?.fetchStatus,
  ).toBe("fetching");
});

it("does not download xterm for a chat thread or repeat fresh discovery", async () => {
  vi.mocked(sdk.nativeTerminals.get).mockResolvedValue(null);
  prefetchThreadOpen("chat");
  await vi.waitFor(() =>
    expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce(),
  );
  await Promise.resolve();
  prefetchThreadOpen("chat");
  await Promise.resolve();
  expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce();
  expect(preloadTerminalModules).not.toHaveBeenCalled();
});

it("warms the native panel on a fresh cached route without waiting for metadata or bootstrap", () => {
  window.history.replaceState({}, "", "/threads/native");
  appQueryClient.setQueryData(nativeTerminalThreadQueryKey("native"), {
    terminal: { id: "term-cached", status: "running" },
  });
  prefetchThreadOpen("native");
  expect(warmNativePanel).toHaveBeenCalledOnce();
  expect(preloadTerminalModules).toHaveBeenCalledOnce();
  expect(sdk.nativeTerminals.get).not.toHaveBeenCalled();
});
