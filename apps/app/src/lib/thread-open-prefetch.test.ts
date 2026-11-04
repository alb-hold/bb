import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "./app-query-client";
import { prefetchThreadOpen } from "./thread-open-prefetch";
import { sdk } from "./sdk";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";

vi.mock("./sdk", () => ({ sdk: { nativeTerminals: { get: vi.fn() } } }));
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
  appQueryClient.clear();
  vi.clearAllMocks();
});

it("starts native discovery while thread bootstrap is pending and warms a native terminal", async () => {
  vi.mocked(sdk.nativeTerminals.get).mockResolvedValue({
    threadId: "native",
    providerId: "codex",
    displayName: "Codex",
    nativeSessionId: null,
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
