import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "./app-query-client";
import { prefetchThreadOpen } from "./thread-open-prefetch";
import { sdk } from "./sdk";
const {
  preloadTerminalModules,
  preloadNativeTerminalPanel,
  panelReady,
  releasePanel,
} = vi.hoisted(() => {
  let releasePanel!: () => void;
  const panelReady = new Promise<void>((resolve) => {
    releasePanel = resolve;
  });
  return {
    panelReady,
    releasePanel,
    preloadTerminalModules: vi.fn(),
    preloadNativeTerminalPanel: vi.fn(() => Promise.resolve()),
  };
});

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
  preloadTerminalModules,
}));
vi.mock(
  "@/components/thread/terminal/native-terminal-panel-preload",
  async () => {
    await panelReady;
    return { preloadNativeTerminalPanel };
  },
);

afterEach(() => {
  appQueryClient.clear();
  vi.clearAllMocks();
});

it("starts native discovery while bootstrap and terminal panel imports are pending", async () => {
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
  expect(sdk.nativeTerminals.get).toHaveBeenCalledOnce();
  expect(preloadNativeTerminalPanel).not.toHaveBeenCalled();
  expect(
    appQueryClient.getQueryState(["bootstrap", "native"])?.fetchStatus,
  ).toBe("fetching");
  releasePanel();
  await vi.waitFor(() =>
    expect(preloadNativeTerminalPanel).toHaveBeenCalledOnce(),
  );
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
