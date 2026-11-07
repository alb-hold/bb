// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/retryable-chunk-import", () => ({ loadChunkWithRetries: load }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("reveals a downloaded native panel without a nested Suspense fallback", async () => {
  vi.resetModules();
  const { NativeTerminalPanel } = await import("./NativeTerminalPanel");
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

it("mounts a panel warmed by the early connector without a loading render", async () => {
  vi.resetModules();
  load.mockResolvedValueOnce({
    ThreadTerminalPanel: () => <div>Warm native replay</div>,
  });
  const { loadNativeTerminalPanel } =
    await import("./native-terminal-panel-loader");
  await loadNativeTerminalPanel();
  const { NativeTerminalPanel } = await import("./NativeTerminalPanel");
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
  expect(screen.getByText("Warm native replay")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});

it("shows the split failure UI and retries a failed chunk download", async () => {
  vi.resetModules();
  const { NativeTerminalPanel } = await import("./NativeTerminalPanel");
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
