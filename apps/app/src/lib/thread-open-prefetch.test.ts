// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "./app-query-client";
import { prefetchThreadOpen } from "./thread-open-prefetch";
import { sdk } from "./sdk";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";

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
