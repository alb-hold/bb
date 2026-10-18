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
import {
  useActiveDeviceHandoffTerminal,
  useActiveDeviceHandoffTerminalView,
} from "./device-handoff-view";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { activeTerminalIdForDeviceHandoff } from "@/views/thread-detail/threadSecondaryPanelSelection";

const copied = vi.hoisted(() => vi.fn());
const registerDeviceHandoff = vi.hoisted(() =>
  vi.fn((_callback: unknown) => () => {}),
);
const acknowledgeDeviceHandoff = vi.hoisted(() => vi.fn());
const setDeviceHandoffView = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: copied,
}));

vi.mock("@/lib/url-open-routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-open-routing")>();
  return {
    ...actual,
    openUrlInExternalBrowser: vi.fn(actual.openUrlInExternalBrowser),
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onDeviceHandoff: registerDeviceHandoff,
    setDeviceHandoffView,
    acknowledgeDeviceHandoff,
  },
}));

afterEach(() => {
  cleanup();
  copied.mockReset();
  vi.mocked(openUrlInExternalBrowser).mockClear();
  registerDeviceHandoff.mockClear();
  setDeviceHandoffView.mockClear();
  acknowledgeDeviceHandoff.mockClear();
});

function DeviceHandoffQueueHarness({
  activeThreadId = null,
  activeTerminalSessionId = null,
}: {
  activeThreadId?: string | null;
  activeTerminalSessionId?: string | null;
}) {
  const queue = useDeviceHandoffQueue(activeThreadId, activeTerminalSessionId);
  return (
    <DeviceHandoffSheet
      signal={queue.signal}
      position={queue.position}
      count={queue.count}
      onDismiss={queue.dismiss}
      onAcknowledge={queue.acknowledge}
    />
  );
}

function SelectedDeviceHandoffQueueHarness() {
  const activeTerminalSessionId = useActiveDeviceHandoffTerminal();
  const queue = useDeviceHandoffQueue(null, activeTerminalSessionId);
  return (
    <DeviceHandoffSheet
      signal={queue.signal}
      position={queue.position}
      count={queue.count}
      onDismiss={queue.dismiss}
      onAcknowledge={queue.acknowledge}
    />
  );
}

function ActiveTerminalPane({
  ownerId,
  terminalId,
  isFocused,
  isOpen,
}: {
  ownerId: string;
  terminalId: string;
  isFocused: boolean;
  isOpen: boolean;
}) {
  useActiveDeviceHandoffTerminalView({
    ownerId,
    terminalId,
    isFocused,
    isOpen,
  });
  return null;
}

function SelectedTerminalPane({ terminalId }: { terminalId: string }) {
  const selectedTab = {
    id: `tab-${terminalId}`,
    kind: "terminal" as const,
    terminalId,
  };
  useActiveDeviceHandoffTerminalView({
    ownerId: "root-compose:root",
    terminalId: activeTerminalIdForDeviceHandoff(selectedTab),
    isFocused: true,
    isOpen: true,
  });
  return null;
}

function ActiveTerminalReadout() {
  const terminalId = useActiveDeviceHandoffTerminal();
  return (
    <output data-testid="active-terminal-id">{terminalId ?? "none"}</output>
  );
}

function ThreadViewHandoffQueueHarness() {
  const terminalId = useActiveDeviceHandoffTerminal();
  const queue = useDeviceHandoffQueue("thread-1", terminalId);
  return (
    <>
      <output data-testid="active-terminal-id">{terminalId ?? "none"}</output>
      <DeviceHandoffSheet
        signal={queue.signal}
        position={queue.position}
        count={queue.count}
        onDismiss={queue.dismiss}
        onAcknowledge={queue.acknowledge}
      />
    </>
  );
}

function MobileRootPanelHandoffHarness({
  isOpen,
  focusedTerminalId,
  includeUnfocusedTerminal,
}: {
  isOpen: boolean;
  focusedTerminalId: string;
  includeUnfocusedTerminal: boolean;
}) {
  const activeTerminalId = useActiveDeviceHandoffTerminal();
  const queue = useDeviceHandoffQueue(null, activeTerminalId);
  return (
    <CompactViewportOverrideProvider isCompactViewport>
      <div
        data-testid="home-right-panel-drawer"
        data-state={isOpen ? "open" : "closed"}
      >
        <button aria-pressed="true">
          Device Handoff Standalone {focusedTerminalId}
        </button>
        <ActiveTerminalPane
          ownerId={`root-compose:${focusedTerminalId}`}
          terminalId={focusedTerminalId}
          isFocused
          isOpen={isOpen}
        />
        <output data-testid="active-terminal-id">
          {activeTerminalId ?? "none"}
        </output>
        {includeUnfocusedTerminal ? (
          <ActiveTerminalPane
            ownerId="root-compose:unfocused-pane"
            terminalId="term-unfocused"
            isFocused={false}
            isOpen
          />
        ) : null}
        <DeviceHandoffSheet
          signal={queue.signal}
          position={queue.position}
          count={queue.count}
          onDismiss={queue.dismiss}
          onAcknowledge={queue.acknowledge}
        />
      </div>
    </CompactViewportOverrideProvider>
  );
}

async function settleDrawerRealization() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 140);
    });
  });
}

describe("DeviceHandoffSheet", () => {
  it("shows queued and live standalone handoffs in the focused phone drawer", async () => {
    const now = Date.now();
    const queued: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "queued-mobile-copy",
      createdAt: now,
      expiresAt: now + 600_000,
      originLabel: "Device Handoff Standalone A",
      request: {
        kind: "copy-text",
        text: "queued phone copy",
        origin: { terminalSessionId: "term-a" },
      },
    };
    const live: DeviceHandoffSignal = {
      ...queued,
      id: "live-mobile-copy",
      request: {
        kind: "copy-text",
        text: "live phone copy",
        origin: { terminalSessionId: "term-a" },
      },
    };

    const { rerender } = render(
      <MobileRootPanelHandoffHarness
        isOpen
        focusedTerminalId="term-a"
        includeUnfocusedTerminal
      />,
    );
    expect(screen.getByTestId("home-right-panel-drawer").dataset.state).toBe(
      "open",
    );
    expect(
      screen
        .getByRole("button", { name: /Standalone term-a/u })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(setDeviceHandoffView).toHaveBeenLastCalledWith(null, "term-a"),
    );

    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    expect(listener).toBeDefined();
    act(() => listener?.(queued));
    expect(await screen.findByText("queued phone copy")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    act(() => listener?.(live));
    expect(await screen.findByText("live phone copy")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(acknowledgeDeviceHandoff).toHaveBeenLastCalledWith(
      "queued-mobile-copy",
    );

    rerender(
      <MobileRootPanelHandoffHarness
        isOpen={false}
        focusedTerminalId="term-a"
        includeUnfocusedTerminal
      />,
    );
    await waitFor(() =>
      expect(setDeviceHandoffView).toHaveBeenLastCalledWith(null, null),
    );
    expect(screen.getByTestId("active-terminal-id").textContent).toBe("none");
    expect(screen.queryByText("live phone copy")).toBeNull();

    rerender(
      <MobileRootPanelHandoffHarness
        isOpen
        focusedTerminalId="term-a"
        includeUnfocusedTerminal
      />,
    );
    await waitFor(() =>
      expect(setDeviceHandoffView).toHaveBeenLastCalledWith(null, "term-a"),
    );
    expect(await screen.findByText("live phone copy")).toBeTruthy();

    rerender(
      <MobileRootPanelHandoffHarness
        isOpen
        focusedTerminalId="term-b"
        includeUnfocusedTerminal
      />,
    );
    await waitFor(() =>
      expect(setDeviceHandoffView).toHaveBeenLastCalledWith(null, "term-b"),
    );
    expect(screen.getByTestId("active-terminal-id").textContent).toBe("term-b");
    expect(screen.queryByText("live phone copy")).toBeNull();
  });

  it("reports focused desktop, thread and split-pane terminal views only", async () => {
    const { rerender } = render(
      <>
        <ActiveTerminalPane
          ownerId="root-compose:desktop"
          terminalId="desktop-terminal"
          isFocused
          isOpen
        />
        <ActiveTerminalPane
          ownerId="thread:thread-1:pane-a"
          terminalId="thread-terminal"
          isFocused={false}
          isOpen
        />
        <ActiveTerminalReadout />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active-terminal-id").textContent).toBe(
        "desktop-terminal",
      ),
    );

    rerender(
      <>
        <ActiveTerminalPane
          ownerId="root-compose:desktop"
          terminalId="desktop-terminal"
          isFocused={false}
          isOpen
        />
        <ActiveTerminalPane
          ownerId="thread:thread-1:pane-a"
          terminalId="thread-terminal"
          isFocused
          isOpen
        />
        <ThreadViewHandoffQueueHarness />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active-terminal-id").textContent).toBe(
        "thread-terminal",
      ),
    );
    expect(setDeviceHandoffView).toHaveBeenLastCalledWith(
      "thread-1",
      "thread-terminal",
    );

    rerender(
      <>
        <ActiveTerminalPane
          ownerId="root-compose:pane-a"
          terminalId="split-a"
          isFocused={false}
          isOpen
        />
        <ActiveTerminalPane
          ownerId="root-compose:pane-b"
          terminalId="split-b"
          isFocused
          isOpen
        />
        <ActiveTerminalReadout />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active-terminal-id").textContent).toBe(
        "split-b",
      ),
    );
  });

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
    const onAcknowledge = vi.fn();
    render(
      <DeviceHandoffSheet
        signal={signal}
        position={1}
        count={1}
        onDismiss={onDismiss}
        onAcknowledge={onAcknowledge}
      />,
    );

    expect(copied).not.toHaveBeenCalled();
    const copyButton = await screen.findByRole("button", { name: "Copy" });
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
    fireEvent.click(copyButton);
    expect(copied).toHaveBeenCalledWith("secret-free test text", {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    });
    await waitFor(() =>
      expect(onAcknowledge).toHaveBeenCalledWith("handoff-1"),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
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
    const onAcknowledge = vi.fn();
    render(
      <DeviceHandoffSheet
        signal={signal}
        position={1}
        count={1}
        onDismiss={onDismiss}
        onAcknowledge={onAcknowledge}
      />,
    );

    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(openUrlInExternalBrowser).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(openUrlInExternalBrowser).toHaveBeenCalledTimes(1);
    expect(openUrlInExternalBrowser).toHaveBeenCalledWith(url);
    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(
      url,
      "_blank",
      "noopener,noreferrer",
    );
    expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith("open-handoff");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    windowOpen.mockRestore();
  });

  it("shows queued handoffs in arrival order and acknowledges only explicit actions", async () => {
    copied.mockResolvedValue(true);
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
    render(<DeviceHandoffQueueHarness activeTerminalSessionId="term_1" />);
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    expect(listener).toBeDefined();

    act(() => {
      for (const handoff of handoffs) listener?.(handoff);
    });

    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();
    expect(await screen.findByText("first copied code")).toBeTruthy();
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByText("second.example")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(acknowledgeDeviceHandoff).toHaveBeenCalledExactlyOnceWith(
        "handoff-first",
      ),
    );

    expect(await screen.findByText("second.example")).toBeTruthy();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.queryByText("third copied code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openUrlInExternalBrowser).toHaveBeenCalledExactlyOnceWith(
      "https://second.example/login",
    );
    expect(acknowledgeDeviceHandoff).toHaveBeenCalledTimes(2);
    expect(acknowledgeDeviceHandoff).toHaveBeenLastCalledWith("handoff-second");

    expect(await screen.findByText("third copied code")).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
    expect(acknowledgeDeviceHandoff).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(acknowledgeDeviceHandoff).toHaveBeenCalledTimes(3);
    expect(acknowledgeDeviceHandoff).toHaveBeenLastCalledWith("handoff-third");
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
        terminalSessionId: null,
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

  it("shows standalone terminal handoffs only while their terminal is active", async () => {
    const first: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "terminal-a-first",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      originLabel: "Standalone A",
      request: {
        kind: "copy-text",
        text: "terminal A first copy",
        origin: { terminalSessionId: "term-a" },
      },
    };
    const second: DeviceHandoffSignal = {
      ...first,
      id: "terminal-a-second",
      request: {
        kind: "copy-text",
        text: "terminal A second copy",
        origin: { terminalSessionId: "term-a" },
      },
    };
    const view = render(<DeviceHandoffQueueHarness />);
    const homeListener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    act(() => {
      homeListener?.(first);
      homeListener?.(second);
    });
    await settleDrawerRealization();
    expect(screen.queryByText("terminal A first copy")).toBeNull();

    view.rerender(
      <DeviceHandoffQueueHarness activeTerminalSessionId="term-b" />,
    );
    await settleDrawerRealization();
    expect(screen.queryByText("terminal A first copy")).toBeNull();
    expect(screen.queryByText("terminal A second copy")).toBeNull();
    expect(acknowledgeDeviceHandoff).not.toHaveBeenCalled();

    view.rerender(
      <DeviceHandoffQueueHarness activeTerminalSessionId="term-a" />,
    );
    expect(await screen.findByText("terminal A first copy")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("terminal A second copy")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("uses the selected mobile panel terminal before its session query resolves", async () => {
    const view = render(
      <CompactViewportOverrideProvider isCompactViewport={true}>
        <SelectedTerminalPane terminalId="term-a" />
        <SelectedDeviceHandoffQueueHarness />
      </CompactViewportOverrideProvider>,
    );
    const listener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    act(() =>
      listener?.({
        type: "device-handoff",
        id: "selected-tab-live",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        originLabel: "Standalone A",
        request: {
          kind: "copy-text",
          text: "selected terminal copy",
          origin: { terminalSessionId: "term-a" },
        },
      }),
    );
    expect(await screen.findByText("selected terminal copy")).toBeTruthy();

    view.rerender(
      <CompactViewportOverrideProvider isCompactViewport={true}>
        <SelectedTerminalPane terminalId="term-b" />
        <SelectedDeviceHandoffQueueHarness />
      </CompactViewportOverrideProvider>,
    );
    expect(screen.queryByText("selected terminal copy")).toBeNull();
  });

  it("shows a threadless expiry notice only on its originating terminal", async () => {
    const view = render(<DeviceHandoffQueueHarness />);
    const homeListener = registerDeviceHandoff.mock.lastCall?.[0] as
      | ((signal: DeviceHandoffSignal | DeviceHandoffExpiredSignal) => void)
      | undefined;
    act(() =>
      homeListener?.({
        type: "device-handoff-expired",
        id: "terminal-expired-1",
        threadId: null,
        terminalSessionId: "term-a",
      }),
    );
    const notice =
      "A link or copied text from this terminal expired before you opened it. Run the command again.";
    expect(screen.queryByText(notice)).toBeNull();

    view.rerender(
      <DeviceHandoffQueueHarness activeTerminalSessionId="term-b" />,
    );
    expect(screen.queryByText(notice)).toBeNull();

    view.rerender(
      <DeviceHandoffQueueHarness activeTerminalSessionId="term-a" />,
    );
    expect(await screen.findByText(notice)).toBeTruthy();
  });
});
