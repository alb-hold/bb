import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "@/lib/app-query-client";
import { sdk } from "@/lib/sdk";
import {
  fetchTerminalScreen,
  prefetchTerminalScreen,
} from "./terminal-screen-prefetch";

vi.mock("@/lib/sdk", () => ({
  sdk: { terminals: { experimental_screen: vi.fn() } },
}));
afterEach(() => {
  appQueryClient.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("shares navigation requests with the renderer and isolates sessions", async () => {
  vi.mocked(sdk.terminals.experimental_screen).mockResolvedValue({
    complete: false,
  } as never);
  const early = prefetchTerminalScreen("first", "thread");
  expect(prefetchTerminalScreen("first", "thread")).toBe(early);
  expect(fetchTerminalScreen("first", "thread")).toBe(early);
  await early;
  expect(sdk.terminals.experimental_screen).toHaveBeenCalledOnce();
  await fetchTerminalScreen("second", "thread");
  expect(sdk.terminals.experimental_screen).toHaveBeenCalledTimes(2);
});

it("expires old snapshots and falls back when screen capture fails", async () => {
  vi.useFakeTimers();
  vi.mocked(sdk.terminals.experimental_screen).mockResolvedValue({
    complete: false,
  } as never);
  prefetchTerminalScreen("expiry", "thread");
  vi.advanceTimersByTime(5001);
  vi.mocked(sdk.terminals.experimental_screen).mockRejectedValueOnce(
    new Error("offline"),
  );
  expect(await fetchTerminalScreen("expiry", "thread")).toBeNull();
  expect(sdk.terminals.experimental_screen).toHaveBeenCalledTimes(2);
});
