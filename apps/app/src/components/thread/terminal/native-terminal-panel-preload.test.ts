import { expect, it, vi } from "vitest";

vi.mock("@/lib/retryable-chunk-import", () => ({
  loadChunkWithRetries: vi.fn(),
}));

it("shares route and mount downloads and retries after failure", async () => {
  const { loadChunkWithRetries } = await import("@/lib/retryable-chunk-import");
  const { preloadNativeTerminalPanel } =
    await import("./native-terminal-panel-preload");
  vi.mocked(loadChunkWithRetries).mockRejectedValueOnce(new Error("offline"));
  const first = preloadNativeTerminalPanel();
  expect(preloadNativeTerminalPanel()).toBe(first);
  await expect(first).rejects.toThrow("offline");
  vi.mocked(loadChunkWithRetries).mockResolvedValueOnce({
    ThreadTerminalPanel: () => null,
  });
  const retry = preloadNativeTerminalPanel();
  expect(retry).not.toBe(first);
  await retry;
  expect(loadChunkWithRetries).toHaveBeenCalledTimes(2);
});
