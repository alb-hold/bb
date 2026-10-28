// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  useThreadTerminalController,
  type ThreadTerminalControllerArgs,
} from "./useThreadTerminalController";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { clearTerminalCurrentCwd } from "./terminal-shell-state";
import { ThreadTerminalContent } from "./ThreadTerminalContent";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        experimental_updateRowState: vi.fn(),
      },
      terminals: {
        ...actual.sdk.terminals,
        list: vi.fn(),
        close: vi.fn(),
        create: vi.fn(),
        rename: vi.fn(),
      },
    },
  };
});

function session(id: string, status: TerminalSession["status"]) {
  return makeTerminalSession({
    id,
    status,
    threadId: "thread-a",
    environmentId: "environment-a",
    hostId: "host-a",
  });
}

function paneArgs(preferredTerminalId: string): ThreadTerminalControllerArgs {
  return {
    canCreateTerminal: true,
    isPanelOpen: true,
    isPanelPersistedOpen: true,
    preferredTerminalId,
    syncThreadId: null,
    target: { kind: "thread", threadId: "thread-a" },
  };
}

beforeEach(() => {
  vi.mocked(sdk.threads.experimental_updateRowState).mockResolvedValue({
    statuses: {},
    progress: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  for (const terminalId of ["terminal-a", "terminal-b", "terminal-orphan", "terminal-new"]) {
    clearTerminalCurrentCwd(terminalId);
  }
});

describe("two split panes each holding a terminal", () => {
  it("writes terminal progress through the existing thread row-state contract", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    vi.mocked(sdk.threads.experimental_updateRowState).mockResolvedValue({
      statuses: {},
      progress: { value: 0.75 },
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    act(() => result.current.handleActiveTerminalProgressChange(0.75));

    await waitFor(() =>
      expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledWith({
        threadId: "thread-a",
        action: "progress-set",
        progress: { value: 0.75 },
      }),
    );
    act(() => result.current.handleActiveTerminalProgressChange(null));
    await waitFor(() =>
      expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
        threadId: "thread-a",
        action: "progress-clear",
      }),
    );
  });

  it("deduplicates progress and coalesces bursts to four updates per second", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    vi.mocked(sdk.threads.experimental_updateRowState).mockResolvedValue({
      statuses: {},
      progress: { value: 0.2 },
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    vi.useFakeTimers();
    act(() => {
      result.current.handleActiveTerminalProgressChange(0.2);
      result.current.handleActiveTerminalProgressChange(0.2);
      result.current.handleActiveTerminalProgressChange(0.4);
      result.current.handleActiveTerminalProgressChange(0.6);
    });

    expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledTimes(1);
    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.2 },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledTimes(2);
    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.6 },
    });
    act(() => result.current.handleActiveTerminalProgressChange(0.6));
    expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    unmount();
  });

  it("clears progress when the active terminal exits", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    act(() => result.current.handleActiveTerminalProgressChange(0.5));
    act(() =>
      result.current.handleActiveTerminalSessionChange(
        session("terminal-a", "exited"),
      ),
    );

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
  });

  it("keeps the previous terminal's progress when a different active terminal exits", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running"), session("terminal-b", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ preferredTerminalId }: { preferredTerminalId: string }) =>
        useThreadTerminalController(paneArgs(preferredTerminalId)),
      { initialProps: { preferredTerminalId: "terminal-a" }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    act(() => result.current.handleActiveTerminalProgressChange(0.6));

    rerender({ preferredTerminalId: "terminal-b" });
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-b"),
    );
    act(() =>
      result.current.handleActiveTerminalSessionChange(
        session("terminal-b", "exited"),
      ),
    );

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.6 },
    });
    expect(sdk.threads.experimental_updateRowState).not.toHaveBeenCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
  });

  it("clears progress when the terminal that reported it exits after switching tabs", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running"), session("terminal-b", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ preferredTerminalId }: { preferredTerminalId: string }) =>
        useThreadTerminalController(paneArgs(preferredTerminalId)),
      { initialProps: { preferredTerminalId: "terminal-a" }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    rerender({ preferredTerminalId: "terminal-b" });
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-b"),
    );
    act(() => result.current.handleActiveTerminalProgressChange(0.4));
    act(() =>
      result.current.handleActiveTerminalSessionChange(
        session("terminal-b", "exited"),
      ),
    );

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
  });

  it("does not let one pane's terminal exit clear progress owned by another pane", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running"), session("terminal-b", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const paneA = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );
    const paneB = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-b")),
      { wrapper },
    );

    await waitFor(() => {
      expect(paneA.result.current.activeSession?.id).toBe("terminal-a");
      expect(paneB.result.current.activeSession?.id).toBe("terminal-b");
    });
    act(() => paneA.result.current.handleActiveTerminalProgressChange(0.6));
    act(() => paneB.result.current.handleActiveTerminalProgressChange(0.4));
    act(() =>
      paneA.result.current.handleActiveTerminalSessionChange(
        session("terminal-a", "exited"),
      ),
    );

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.4 },
    });
    expect(sdk.threads.experimental_updateRowState).not.toHaveBeenCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });

    act(() =>
      paneB.result.current.handleActiveTerminalSessionChange(
        session("terminal-b", "exited"),
      ),
    );
    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
  });

  it("clears progress when the active terminal closes with its panel", async () => {
    const created = session("terminal-new", "running");
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [created] });
    vi.mocked(sdk.terminals.create).mockResolvedValue(created);
    vi.mocked(sdk.terminals.close).mockResolvedValue(
      session("terminal-new", "exited"),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useThreadTerminalController({
          ...paneArgs("terminal-new"),
          isPanelOpen: open,
          isPanelPersistedOpen: open,
        }),
      { initialProps: { open: true }, wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-new"),
    );
    act(() => result.current.handleCreateTerminal());
    await waitFor(() => expect(sdk.terminals.create).toHaveBeenCalled());
    act(() => result.current.handleActiveTerminalProgressChange(0.5));

    rerender({ open: false });
    await waitFor(() => expect(sdk.terminals.close).toHaveBeenCalled());

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
  });

  it("keeps terminal progress when its controller unmounts while the terminal remains open", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    act(() => result.current.handleActiveTerminalProgressChange(0.5));
    unmount();

    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.5 },
    });
  });

  it("sends no progress write when a terminal that never reported progress unmounts", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("terminal-a"),
    );
    unmount();

    expect(sdk.threads.experimental_updateRowState).not.toHaveBeenCalled();
  });

  it("does not clear progress set by another pane when a pane that never set progress unmounts", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running"), session("terminal-b", "running")],
    });
    const { wrapper } = createQueryClientTestHarness();
    const paneA = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );
    const paneB = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-b")),
      { wrapper },
    );

    await waitFor(() => {
      expect(paneA.result.current.activeSession?.id).toBe("terminal-a");
      expect(paneB.result.current.activeSession?.id).toBe("terminal-b");
    });
    act(() => paneA.result.current.handleActiveTerminalProgressChange(0.6));
    expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledTimes(1);

    paneB.unmount();
    act(() =>
      paneB.result.current.handleActiveTerminalSessionChange(
        session("terminal-b", "exited"),
      ),
    );

    expect(sdk.threads.experimental_updateRowState).toHaveBeenCalledTimes(1);
    expect(sdk.threads.experimental_updateRowState).not.toHaveBeenCalledWith({
      threadId: "thread-a",
      action: "progress-clear",
    });
    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.6 },
    });

    paneA.unmount();
    expect(sdk.threads.experimental_updateRowState).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      action: "progress-set",
      progress: { value: 0.6 },
    });
  });

  it("does not let program titles block cwd title updates", async () => {
    const current = session("terminal-a", "running");
    current.title = "bash";
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [current] });
    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession).toMatchObject({
        id: "terminal-a",
        title: "bash",
        status: "running",
      }),
    );
    act(() => result.current.handleActiveTerminalTitleChange("build output"));
    act(() =>
      result.current.handleActiveTerminalCwdChange("/workspace/project"),
    );

    await waitFor(() =>
      expect(sdk.terminals.rename).toHaveBeenCalledWith({
        terminalId: "terminal-a",
        title: "project",
      }),
    );
    unmount();
  });

  it("a user-renamed terminal keeps its title when the program emits a title", async () => {
    const current = session("terminal-a", "running");
    current.title = "deploy";
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [current] });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.title).toBe("deploy"),
    );
    act(() =>
      result.current.handleActiveTerminalTitleChange("user@host:~/proj"),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(sdk.terminals.rename).not.toHaveBeenCalled();
  });

  it("successive program titles keep updating the title", async () => {
    const current = session("terminal-a", "running");
    current.title = "bash";
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [current] });
    vi.mocked(sdk.terminals.rename).mockImplementation(async ({ title }) => ({
      ...current,
      title,
    }));

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.activeSession?.title).toBe("bash"),
    );
    act(() => result.current.handleActiveTerminalTitleChange("vim"));

    await waitFor(() =>
      expect(sdk.terminals.rename).toHaveBeenCalledWith({
        terminalId: "terminal-a",
        title: "vim",
      }),
    );
    act(() =>
      result.current.handleActiveTerminalSessionChange({
        ...current,
        title: "vim",
      }),
    );

    act(() => result.current.handleActiveTerminalTitleChange("vim main.ts"));
    await waitFor(() =>
      expect(sdk.terminals.rename).toHaveBeenLastCalledWith({
        terminalId: "terminal-a",
        title: "vim main.ts",
      }),
    );
  });

  it("shows a loading state while the terminal sessions query is pending", () => {
    vi.mocked(sdk.terminals.list).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { wrapper } = createQueryClientTestHarness();
    function PendingTerminalPane() {
      const controller = useThreadTerminalController(paneArgs("terminal-a"));
      return (
        <ThreadTerminalContent
          controller={controller}
          onCloseStart={() => undefined}
          onRetryStart={() => undefined}
        />
      );
    }

    render(<PendingTerminalPane />, { wrapper });

    expect(screen.getByRole("status").textContent).toBe("Loading terminals...");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No terminals")).toBeNull();
  });

  it("does not close the other pane's terminal when both disconnect", async () => {
    const running = [
      session("terminal-a", "running"),
      session("terminal-b", "running"),
    ];
    vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: running });
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) =>
        session(terminalId, "exited"),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => ({
        paneA: useThreadTerminalController(paneArgs("terminal-a")),
        paneB: useThreadTerminalController(paneArgs("terminal-b")),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.id).toBe("terminal-a");
      expect(result.current.paneB.activeSession?.id).toBe("terminal-b");
    });

    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [
        session("terminal-a", "disconnected"),
        session("terminal-b", "disconnected"),
      ],
    });
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.status).toBe("disconnected");
      expect(result.current.paneB.activeSession?.status).toBe("disconnected");
    });

    const closedIds = [
      ...new Set(
        vi
          .mocked(sdk.terminals.close)
          .mock.calls.map(([request]) => request.terminalId),
      ),
    ].sort();
    expect(closedIds).toEqual([]);
  });

  it("keeps its own disconnected terminal when a single pane is open", async () => {
    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "running")],
    });
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) =>
        session(terminalId, "exited"),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadTerminalController(paneArgs("terminal-a")),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("terminal-a");
    });

    vi.mocked(sdk.terminals.list).mockResolvedValue({
      sessions: [session("terminal-a", "disconnected")],
    });
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() => {
      expect(result.current.activeSession?.status).toBe("disconnected");
    });

    expect(vi.mocked(sdk.terminals.close)).not.toHaveBeenCalled();
    expect(result.current.shouldRetainActiveTerminalView).toBe(true);
  });

  it("still closes a disconnected session no pane is showing", async () => {
    const state = new Map<string, TerminalSession["status"]>([
      ["terminal-a", "running"],
      ["terminal-b", "running"],
      ["terminal-orphan", "disconnected"],
    ]);
    vi.mocked(sdk.terminals.list).mockImplementation(async () => ({
      sessions: [...state.entries()].map(([id, status]) => session(id, status)),
    }));
    vi.mocked(sdk.terminals.close).mockImplementation(
      async ({ terminalId }: { terminalId: string }) => {
        state.set(terminalId, "exited");
        return session(terminalId, "exited");
      },
    );

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => ({
        paneA: useThreadTerminalController(paneArgs("terminal-a")),
        paneB: useThreadTerminalController(paneArgs("terminal-b")),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.paneA.activeSession?.id).toBe("terminal-a");
      expect(result.current.paneB.activeSession?.id).toBe("terminal-b");
    });
    await waitFor(() => {
      expect(state.get("terminal-orphan")).toBe("exited");
    });

    const closedIds = [
      ...new Set(
        vi
          .mocked(sdk.terminals.close)
          .mock.calls.map(([request]) => request.terminalId),
      ),
    ];
    expect(closedIds).toEqual(["terminal-orphan"]);
  });

  it.each(["/tmp/q?x", "/tmp/h#x", "/tmp/p%20x", "/tmp/s p", "/tmp/café"])(
    "opens a new terminal in the focused pane's cwd: %s",
    async (cwd) => {
      const source = session("terminal-a", "running");
      const created = session("terminal-new", "running");
      vi.mocked(sdk.terminals.list).mockResolvedValue({ sessions: [source] });
      vi.mocked(sdk.terminals.create).mockResolvedValue(created);
      const { wrapper } = createQueryClientTestHarness();
      const { result } = renderHook(
        () => useThreadTerminalController(paneArgs("terminal-a")),
        { wrapper },
      );

      await waitFor(() =>
        expect(result.current.activeSession?.id).toBe("terminal-a"),
      );
      act(() => result.current.handleActiveTerminalCwdChange(cwd));
      act(() => result.current.handleCreateTerminal());

      await waitFor(() => expect(sdk.terminals.create).toHaveBeenCalled());
      expect(sdk.terminals.create).toHaveBeenCalledWith(
        expect.objectContaining({ cwd }),
      );
    },
  );
});
