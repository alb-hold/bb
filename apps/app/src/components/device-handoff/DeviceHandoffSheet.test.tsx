// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceHandoffExpiredSignal,
  DeviceHandoffSignal,
} from "@bb/server-contract";
import { DeviceHandoffSheet } from "./DeviceHandoffSheet";
import { useDeviceHandoffQueue } from "./useDeviceHandoffQueue";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const copied = vi.hoisted(() => vi.fn());
const registerDeviceHandoff = vi.hoisted(() =>
  vi.fn((_callback: unknown) => () => {}),
);
const acknowledgeDeviceHandoff = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: copied,
}));

vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: vi.fn(),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onDeviceHandoff: registerDeviceHandoff,
    setDeviceHandoffView: vi.fn(),
    acknowledgeDeviceHandoff,
  },
}));

afterEach(() => {
  cleanup();
  copied.mockReset();
  registerDeviceHandoff.mockClear();
  acknowledgeDeviceHandoff.mockClear();
});

function DeviceHandoffQueueHarness({
  activeThreadId = null,
}: {
  activeThreadId?: string | null;
}) {
  const queue = useDeviceHandoffQueue(activeThreadId);
  return (
    <DeviceHandoffSheet
      signal={queue.signal}
      position={queue.position}
      count={queue.count}
      onDismiss={queue.dismiss}
      onShown={queue.acknowledgeShown}
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
      expiresAt: Date.now() + 600_000,
      originLabel: "Terminal",
      request: {
        kind: "copy-text",
        text: "secret-free test text",
        origin: { terminalSessionId: "term_1" },
      },
    };
    const onDismiss = vi.fn();
    const onShown = vi.fn();
    render(
      <DeviceHandoffSheet
        signal={signal}
        position={1}
        count={1}
        onDismiss={onDismiss}
        onShown={onShown}
      />,
    );

    expect(copied).not.toHaveBeenCalled();
    const copyButton = await screen.findByRole("button", { name: "Copy" });
    await waitFor(() => expect(onShown).toHaveBeenCalledWith("handoff-1"));
    expect(copied).not.toHaveBeenCalled();
    fireEvent.click(copyButton);
    expect(copied).toHaveBeenCalledWith("secret-free test text", {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    });
  });

  it("opens the requested URL and acknowledges it only after the user taps Open", async () => {
    const url = "https://example.com/dh-open";
    const signal: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "open-handoff",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      originLabel: "Terminal",
      request: {
        kind: "open-url",
        url,
        origin: { terminalSessionId: "term_1" },
      },
    };
    const onDismiss = vi.fn();
    const onShown = vi.fn();
    render(
      <DeviceHandoffSheet
        signal={signal}
        position={1}
        count={1}
        onDismiss={onDismiss}
        onShown={onShown}
      />,
    );

    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(openUrlInExternalBrowser).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(openUrlInExternalBrowser).toHaveBeenCalledTimes(1);
    expect(openUrlInExternalBrowser).toHaveBeenCalledWith(url);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows queued handoffs in arrival order when several arrive before dismissal", async () => {
    const now = Date.now();
    const handoffs: DeviceHandoffSignal[] = [
      {
        type: "device-handoff",
        id: "handoff-first",
        createdAt: now,
        expiresAt: now + 600_000,
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
        expiresAt: now + 600_001,
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
        expiresAt: now + 600_002,
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
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    expect(listener).toBeDefined();

    act(() => {
      for (const handoff of handoffs) listener?.(handoff);
    });

    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();
    expect(await screen.findByText("first copied code")).toBeTruthy();
    await waitFor(() =>
      expect(acknowledgeDeviceHandoff).toHaveBeenCalledWith("handoff-first"),
    );
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

  it("does not show or acknowledge a handoff while displaying another thread", () => {
    const signal: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "hidden-handoff",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      originLabel: "Source thread",
      request: {
        kind: "copy-text",
        text: "hidden payload",
        origin: { threadId: "thr_source" },
      },
    };
    render(<DeviceHandoffQueueHarness activeThreadId="thr_elsewhere" />);
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;

    act(() => listener?.(signal));

    expect(screen.queryByText("hidden payload")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();
  });

  it("keeps handoffs partitioned while navigating from thread A to B and back", async () => {
    const now = Date.now();
    const firstA: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "thread-a-copy",
      createdAt: now,
      expiresAt: now + 600_000,
      originLabel: "Thread A terminal",
      request: {
        kind: "copy-text",
        text: "thread A copied code",
        origin: { threadId: "thread-a", terminalSessionId: "term-a1" },
      },
    };
    const secondA: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "thread-a-url",
      createdAt: now + 1,
      expiresAt: now + 600_001,
      originLabel: "Thread A terminal",
      request: {
        kind: "open-url",
        url: "https://thread-a.example/login",
        origin: { threadId: "thread-a", terminalSessionId: "term-a2" },
      },
    };
    const threadB: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "thread-b-copy",
      createdAt: now + 2,
      expiresAt: now + 600_002,
      originLabel: "Thread B terminal",
      request: {
        kind: "copy-text",
        text: "thread B copied code",
        origin: { threadId: "thread-b", terminalSessionId: "term-b" },
      },
    };
    const view = render(
      <DeviceHandoffQueueHarness activeThreadId="thread-a" />,
    );
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    expect(listener).toBeDefined();

    act(() => {
      listener?.(firstA);
      listener?.(secondA);
    });
    view.rerender(<DeviceHandoffQueueHarness activeThreadId="thread-b" />);

    expect(screen.queryByText("thread A copied code")).toBeNull();
    expect(screen.queryByText("thread-a.example")).toBeNull();
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalledWith(firstA.id);
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalledWith(secondA.id);

    const threadBListener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    act(() => threadBListener?.(threadB));
    expect(await screen.findByText("thread B copied code")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.queryByText("thread A copied code")).toBeNull();
    expect(screen.queryByText("thread-a.example")).toBeNull();

    view.rerender(<DeviceHandoffQueueHarness activeThreadId="thread-a" />);
    expect(await screen.findByText("thread A copied code")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.queryByText("thread B copied code")).toBeNull();
    expect(screen.queryByText("thread-a.example")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("thread-a.example")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("shows the payload-free notice when an expired handoff is delivered", async () => {
    render(<DeviceHandoffQueueHarness activeThreadId="thr_1" />);
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;

    act(() => {
      listener?.({
        type: "device-handoff-expired",
        id: "expired-1",
        threadId: "thr_1",
      });
    });

    expect(
      await screen.findByText(
        "A link or copied text from this terminal expired before you opened it. Run the command again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
