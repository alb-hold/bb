// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceHandoffSignal } from "@bb/server-contract";
import { DeviceHandoffSheet } from "./DeviceHandoffSheet";
import { useDeviceHandoffQueue } from "./useDeviceHandoffQueue";

const copied = vi.hoisted(() => vi.fn());
const registerDeviceHandoff = vi.hoisted(() =>
  vi.fn((_callback: unknown) => () => {}),
);

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: copied,
}));

vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: vi.fn(),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { onDeviceHandoff: registerDeviceHandoff },
}));

afterEach(() => {
  cleanup();
  copied.mockReset();
  registerDeviceHandoff.mockClear();
});

function DeviceHandoffQueueHarness() {
  const queue = useDeviceHandoffQueue();
  return (
    <DeviceHandoffSheet
      signal={queue.signal}
      position={queue.position}
      count={queue.count}
      onDismiss={queue.dismiss}
    />
  );
}

describe("DeviceHandoffSheet", () => {
  it("copies text only after the user taps Copy", async () => {
    copied.mockResolvedValue(true);
    const signal: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "handoff-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000,
      originLabel: "Terminal",
      request: {
        kind: "copy-text",
        text: "secret-free test text",
        origin: { terminalSessionId: "term_1" },
      },
    };
    const onDismiss = vi.fn();
    render(
      <DeviceHandoffSheet
        signal={signal}
        position={1}
        count={1}
        onDismiss={onDismiss}
      />,
    );

    expect(copied).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(copied).toHaveBeenCalledWith("secret-free test text", {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    });
  });

  it("shows queued handoffs in arrival order when several arrive before dismissal", async () => {
    const now = Date.now();
    const handoffs: DeviceHandoffSignal[] = [
      {
        type: "device-handoff",
        id: "handoff-first",
        createdAt: now,
        expiresAt: now + 120_000,
        originLabel: "Terminal",
        request: {
          kind: "copy-text",
          text: "first copied code",
          origin: { terminalSessionId: "term_1" },
        },
      },
      {
        type: "device-handoff",
        id: "handoff-second",
        createdAt: now + 1,
        expiresAt: now + 120_001,
        originLabel: "Terminal",
        request: {
          kind: "open-url",
          url: "https://second.example/login",
          origin: { terminalSessionId: "term_1" },
        },
      },
      {
        type: "device-handoff",
        id: "handoff-third",
        createdAt: now + 2,
        expiresAt: now + 120_002,
        originLabel: "Terminal",
        request: {
          kind: "copy-text",
          text: "third copied code",
          origin: { terminalSessionId: "term_1" },
        },
      },
    ];
    render(<DeviceHandoffQueueHarness />);
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal) => void)
      | undefined;
    expect(listener).toBeDefined();

    act(() => {
      for (const handoff of handoffs) listener?.(handoff);
    });

    expect(await screen.findByText("first copied code")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByText("second.example")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("second.example")).toBeTruthy();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.queryByText("third copied code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("third copied code")).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("third copied code")).toBeNull();
  });
});
