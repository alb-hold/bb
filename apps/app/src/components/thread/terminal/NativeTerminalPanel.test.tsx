// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTerminalPanel } from "./NativeTerminalPanel";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/retryable-chunk-import", () => ({ loadChunkWithRetries: load }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
