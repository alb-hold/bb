// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTerminalPanel } from "./NativeTerminalPanel";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/retryable-chunk-import", () => ({
  loadChunkWithRetries: load,
}));
vi.mock("./terminal-screen-prefetch", () => ({
  prefetchTerminalScreen: vi.fn(() => Promise.resolve(null)),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("paints literal snapshot text while the panel chunk is pending and removes it on unmount", async () => {
  const { prefetchTerminalScreen } = await import("./terminal-screen-prefetch");
  load.mockImplementationOnce(() => new Promise(() => {}));
  vi.mocked(prefetchTerminalScreen).mockResolvedValueOnce({
    rows: ["<b>native snapshot</b>"],
    cursor: { col: 0, row: 0 },
    cols: 80,
    gridRows: 24,
    complete: true,
    truncated: false,
  });
  const { container, unmount } = render(
    <NativeTerminalPanel
      terminalId="early"
      target={{ kind: "thread", threadId: "thread" }}
      isPanelOpen
      isPanelPersistedOpen
      onCloseStart={() => {}}
      onRetryStart={() => {}}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector("pre")?.textContent).toBe(
      "<b>native snapshot</b>",
    ),
  );
  expect(container.querySelector("b")).toBeNull();
  expect(screen.getByRole("status")).toBeTruthy();
  expect(prefetchTerminalScreen).toHaveBeenCalledWith("early", "thread");
  unmount();
  expect(container.querySelector("pre")).toBeNull();
});

it("reveals a downloaded native panel without a nested Suspense fallback", async () => {
  let finish: ((module: object) => void) | undefined;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <NativeTerminalPanel
      terminalId="terminal"
      target={{ kind: "thread", threadId: "thread" }}
      isPanelOpen
      isPanelPersistedOpen
      onCloseStart={() => {}}
      onRetryStart={() => {}}
    />,
  );
  expect(screen.getByRole("status")).toBeTruthy();
  finish?.({ ThreadTerminalPanel: () => <div>Native replay</div> });
  await waitFor(() => expect(screen.getByText("Native replay")).toBeTruthy());
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not paint a snapshot that arrives after unmount", async () => {
  const { prefetchTerminalScreen } = await import("./terminal-screen-prefetch");
  let finish:
    | ((value: Awaited<ReturnType<typeof prefetchTerminalScreen>>) => void)
    | undefined;
  load.mockImplementationOnce(() => new Promise(() => {}));
  vi.mocked(prefetchTerminalScreen).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { container, unmount } = render(
    <NativeTerminalPanel
      terminalId="late"
      target={{ kind: "thread", threadId: "thread" }}
      isPanelOpen
      isPanelPersistedOpen
      onCloseStart={() => {}}
      onRetryStart={() => {}}
    />,
  );
  unmount();
  finish?.({
    rows: ["late"],
    cursor: { col: 0, row: 0 },
    cols: 80,
    gridRows: 24,
    complete: true,
    truncated: false,
  });
  await Promise.resolve();
  expect(container.querySelector("pre")).toBeNull();
});

it("shows the split failure UI and retries a failed chunk download", async () => {
  load.mockRejectedValueOnce(new Error("download failed"));
  load.mockResolvedValueOnce({
    ThreadTerminalPanel: () => <div>Recovered native panel</div>,
  });
  render(
    <NativeTerminalPanel
      terminalId="terminal"
      target={{ kind: "thread", threadId: "thread" }}
      isPanelOpen
      isPanelPersistedOpen
      onCloseStart={() => {}}
      onRetryStart={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  screen.getByRole("button", { name: "Try again" }).click();
  await waitFor(() =>
    expect(screen.getByText("Recovered native panel")).toBeTruthy(),
  );
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
